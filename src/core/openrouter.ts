import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Uma chamada ao modelo que devolve JSON validado.
 *
 * Pede `response_format: json_schema` com `strict`, que é o caminho em que o
 * provedor garante o formato. Mas o parse defensivo continua valendo: nem todo
 * endpoint honra structured output, e um dia de roteamento ruim devolve texto
 * solto. Quem chama trata `ErroModelo` e segue.
 */
const logger = log.com({ componente: 'openrouter' });

const TIMEOUT_MS = 90_000;

export class ErroModelo extends Error {
  constructor(
    message: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = 'ErroModelo';
  }
}

/** `$schema` no topo faz alguns validadores de strict mode recusarem o payload. */
function paraJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignorado, ...resto } = z.toJSONSchema(schema) as Record<string, unknown>;
  return resto;
}

/**
 * Isola o objeto JSON de uma resposta que pode vir suja: cercada por ```json,
 * com texto antes ou depois. Devolve null se não houver objeto reconhecível.
 */
export function extrairJson(bruto: string): unknown {
  const texto = bruto.trim();
  if (texto === '') return null;

  const semCerca = texto
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidatos = [semCerca];

  const inicio = semCerca.indexOf('{');
  const fim = semCerca.lastIndexOf('}');
  if (inicio !== -1 && fim > inicio) candidatos.push(semCerca.slice(inicio, fim + 1));

  for (const candidato of candidatos) {
    try {
      return JSON.parse(candidato);
    } catch {
      /* tenta o próximo */
    }
  }

  return null;
}

interface RespostaOpenRouter {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; code?: number };
}

interface Pedido {
  system: string;
  user: string;
  /** Nome do schema, para o provedor. snake_case. */
  nome: string;
  maxTokens?: number;
  /** Sobrescreve o modelo padrão — a triagem usa um mais barato. */
  modelo?: string;
}

function montarCorpo(pedido: Pedido, schema: z.ZodType, comSchema: boolean): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    model: pedido.modelo ?? config.openrouter.modelo,
    max_tokens: pedido.maxTokens ?? 8000,
    messages: [
      { role: 'system', content: pedido.system },
      { role: 'user', content: pedido.user },
    ],
    // Mandar `effort: 'none'` explicitamente é o que DESLIGA o raciocínio.
    // Omitir não desliga: o modelo pensa por padrão, e esses tokens contam
    // como saída — foi o que truncou respostas em produção.
    reasoning: { effort: config.openrouter.reasoningEffort },
  };

  if (comSchema) {
    corpo.response_format = {
      type: 'json_schema',
      json_schema: { name: pedido.nome, strict: true, schema: paraJsonSchema(schema) },
    };
    corpo.provider = { require_parameters: true };
  }

  return corpo;
}

async function chamar(corpo: Record<string, unknown>): Promise<RespostaOpenRouter> {
  const resposta = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openrouter.apiKey}`,
      'X-Title': 'radar-criadores',
    },
    body: JSON.stringify(corpo),
  });

  const bruto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroModelo(`OpenRouter devolveu ${resposta.status}: ${bruto.slice(0, 400)}`);
  }

  try {
    return JSON.parse(bruto) as RespostaOpenRouter;
  } catch {
    throw new ErroModelo(`resposta do OpenRouter não era JSON: ${bruto.slice(0, 200)}`);
  }
}

/** Valida o texto devolvido contra o schema. Lança `ErroModelo` se não der. */
export function interpretar<T>(bruto: string, schema: z.ZodType<T>): T {
  const json = extrairJson(bruto);
  if (json === null) {
    throw new ErroModelo(`resposta não continha JSON: ${bruto.slice(0, 200)}`);
  }

  const validado = schema.safeParse(json);
  if (!validado.success) {
    const problemas = validado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ErroModelo(`resposta fora do formato esperado (${problemas})`);
  }

  return validado.data;
}

/** Faz o pedido e devolve o JSON já validado. */
export async function pedirJson<T>(pedido: Pedido, schema: z.ZodType<T>): Promise<T> {
  let dados: RespostaOpenRouter;

  try {
    dados = await chamar(montarCorpo(pedido, schema, true));
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const semSuporte = /response_format|json_schema|structured|require_parameters|no endpoints/i.test(mensagem);

    if (!semSuporte) {
      throw erro instanceof ErroModelo ? erro : new ErroModelo(mensagem, erro);
    }

    // Endpoint sem structured output: as instruções já pedem JSON puro e o
    // parse defensivo cobre o resto.
    logger.warn('endpoint sem structured output — repetindo sem schema', {
      modelo: pedido.modelo ?? config.openrouter.modelo,
      detalhe: mensagem.slice(0, 200),
    });
    dados = await chamar(montarCorpo(pedido, schema, false));
  }

  if (dados.error) {
    throw new ErroModelo(`OpenRouter: ${dados.error.message ?? 'erro sem mensagem'}`);
  }

  const escolha = dados.choices?.[0];
  if (!escolha) throw new ErroModelo('OpenRouter não devolveu nenhuma escolha');
  if (escolha.finish_reason === 'length') throw new ErroModelo('resposta truncada em max_tokens');

  const conteudo = escolha.message?.content;
  if (typeof conteudo !== 'string' || conteudo.trim() === '') {
    throw new ErroModelo(`conteúdo vazio (finish_reason: ${escolha.finish_reason ?? 'desconhecido'})`);
  }

  return interpretar(conteudo, schema);
}
