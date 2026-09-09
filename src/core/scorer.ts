import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Creator, Item } from '../db/types.js';

/**
 * Uma chamada ao modelo por item, via OpenRouter (API compatível com a da OpenAI).
 *
 * Pedimos `response_format: json_schema` com `strict`, que é o caminho em que o
 * provedor garante o formato. Mas o parse defensivo continua valendo de verdade:
 * nem todo endpoint honra structured output, e um dia de roteamento ruim devolve
 * texto solto. Se vier fora do formato, o `process` marca o delivery como falho
 * e a rodada segue.
 */
const logger = log.com({ componente: 'scorer' });

const RespostaScorer = z.object({
  score: z.number().describe('0 a 10: o quanto este item merece virar vídeo para ESTA criadora'),
  motivo: z.string().describe('Uma linha explicando a nota'),
  resumo: z.string().describe('2 a 3 linhas com os pontos mais interessantes do item'),
  gancho: z.string().describe('O ângulo/abertura sugerido para o vídeo, em uma frase'),
});

export type RespostaScorer = z.infer<typeof RespostaScorer>;

/** `$schema` no topo faz alguns validadores de strict mode recusarem o payload. */
function schemaDoModelo(): Record<string, unknown> {
  const { $schema: _ignorado, ...schema } = z.toJSONSchema(RespostaScorer) as Record<string, unknown>;
  return schema;
}

const JSON_SCHEMA = schemaDoModelo();

/** Falha de scoring. O job registra e marca o delivery como falho — não derruba a rodada. */
export class ErroScorer extends Error {
  constructor(
    message: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = 'ErroScorer';
  }
}

/** Corta o texto do item para não estourar contexto com uma matéria gigante. */
const LIMITE_TEXTO = 12_000;
const TIMEOUT_MS = 90_000;

const INSTRUCOES = `Você avalia novidades para uma criadora de conteúdo brasileira.

Para cada item, decida o quanto ele merece virar vídeo para ESTA criadora
especificamente — não para o público em geral. O valor do produto está na
velocidade: ela grava antes dos outros sobre o que acabou de sair.

Como pontuar (0 a 10):
- 9-10: é exatamente a praia dela, é novo, e sair na frente faz diferença real
- 6-8: encaixa no que ela cobre, vale considerar
- 3-5: tangencia o nicho, mas não é o forte dela
- 0-2: fora do nicho, requentado, ou institucional demais para render vídeo

Ao escrever:
- "resumo": 2 a 3 linhas com os pontos mais interessantes, o suficiente para ela
  decidir se grava. Sem enrolação, sem repetir o título.
- "gancho": a abertura do vídeo, em uma frase, na voz dela. É o que prende nos
  primeiros três segundos — não é uma descrição do assunto.
- "motivo": uma linha só, explicando a nota que você deu.

Responda em português do Brasil e devolva APENAS um objeto JSON com exatamente
as chaves score, motivo, resumo e gancho. Sem markdown, sem texto em volta.`;

function montarConteudoItem(
  item: Pick<Item, 'titulo' | 'texto' | 'autor' | 'publicado_em' | 'url'>,
  nomeFonte: string,
): string {
  const texto = (item.texto ?? '').trim().slice(0, LIMITE_TEXTO);

  return [
    `Fonte: ${nomeFonte}`,
    item.autor ? `Autor: ${item.autor}` : null,
    item.publicado_em ? `Publicado em: ${item.publicado_em}` : null,
    `URL: ${item.url}`,
    '',
    `Título: ${item.titulo}`,
    '',
    texto
      ? `Conteúdo:\n${texto}`
      : '(o item não trouxe corpo de texto — avalie pelo título e pela fonte)',
  ]
    .filter((linha) => linha !== null)
    .join('\n');
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

/** Valida e normaliza a resposta do modelo. Lança `ErroScorer` se não der. */
export function interpretarResposta(bruto: string): RespostaScorer {
  const json = extrairJson(bruto);
  if (json === null) {
    throw new ErroScorer(`resposta não continha JSON: ${bruto.slice(0, 200)}`);
  }

  const validado = RespostaScorer.safeParse(json);
  if (!validado.success) {
    const problemas = validado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ErroScorer(`resposta fora do formato esperado (${problemas})`);
  }

  const saida = validado.data;

  return {
    // A nota é o eixo de toda a calibragem: um valor fora da faixa estragaria
    // o resto do sistema silenciosamente.
    score: Math.min(10, Math.max(0, Math.round(saida.score))),
    motivo: saida.motivo.trim(),
    resumo: saida.resumo.trim(),
    gancho: saida.gancho.trim(),
  };
}

interface RespostaOpenRouter {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; code?: number };
}

function montarCorpo(perfil: string, conteudoItem: string, comSchema: boolean): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    model: config.openrouter.modelo,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: `${INSTRUCOES}\n\n---\n\n${perfil}` },
      { role: 'user', content: conteudoItem },
    ],
  };

  if (comSchema) {
    corpo.response_format = {
      type: 'json_schema',
      json_schema: { name: 'avaliacao_item', strict: true, schema: JSON_SCHEMA },
    };
    // Só roteia para endpoints que realmente suportam o parâmetro.
    corpo.provider = { require_parameters: true };
  }

  if (config.openrouter.reasoningEffort !== 'none') {
    corpo.reasoning = { effort: config.openrouter.reasoningEffort };
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
      // Atribuição — aparece no painel do OpenRouter e ajuda a separar o gasto.
      'X-Title': 'radar-criadores',
    },
    body: JSON.stringify(corpo),
  });

  const bruto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroScorer(`OpenRouter devolveu ${resposta.status}: ${bruto.slice(0, 400)}`);
  }

  try {
    return JSON.parse(bruto) as RespostaOpenRouter;
  } catch {
    throw new ErroScorer(`resposta do OpenRouter não era JSON: ${bruto.slice(0, 200)}`);
  }
}

export interface EntradaScorer {
  creator: Pick<Creator, 'nome' | 'nicho' | 'perfil_texto'>;
  item: Pick<Item, 'titulo' | 'texto' | 'autor' | 'publicado_em' | 'url'>;
  nomeFonte: string;
}

export async function pontuar(entrada: EntradaScorer): Promise<RespostaScorer> {
  const { creator, item, nomeFonte } = entrada;

  const perfil = [
    `Criadora: ${creator.nome}`,
    creator.nicho ? `Nicho: ${creator.nicho}` : null,
    '',
    'Perfil dela — o que ela cobre:',
    creator.perfil_texto.trim(),
  ]
    .filter((linha) => linha !== null)
    .join('\n');

  const conteudoItem = montarConteudoItem(item, nomeFonte);

  let dados: RespostaOpenRouter;
  try {
    dados = await chamar(montarCorpo(perfil, conteudoItem, true));
  } catch (erro) {
    // Endpoint sem suporte a structured output: tenta de novo sem o schema.
    // As instruções já pedem JSON puro, e o parse defensivo cobre o resto.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const semSuporte = /response_format|json_schema|structured|require_parameters|no endpoints/i.test(mensagem);

    if (!semSuporte) {
      throw erro instanceof ErroScorer ? erro : new ErroScorer(mensagem, erro);
    }

    logger.warn('endpoint sem structured output — repetindo sem schema', {
      modelo: config.openrouter.modelo,
      detalhe: mensagem.slice(0, 200),
    });

    dados = await chamar(montarCorpo(perfil, conteudoItem, false));
  }

  if (dados.error) {
    throw new ErroScorer(`OpenRouter: ${dados.error.message ?? 'erro sem mensagem'}`);
  }

  const escolha = dados.choices?.[0];
  if (!escolha) throw new ErroScorer('OpenRouter não devolveu nenhuma escolha');

  if (escolha.finish_reason === 'length') {
    throw new ErroScorer('resposta truncada em max_tokens');
  }

  const conteudo = escolha.message?.content;
  if (typeof conteudo !== 'string' || conteudo.trim() === '') {
    throw new ErroScorer(`conteúdo vazio (finish_reason: ${escolha.finish_reason ?? 'desconhecido'})`);
  }

  return interpretarResposta(conteudo);
}
