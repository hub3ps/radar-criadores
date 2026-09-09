import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';
import type { Creator, Item } from '../db/types.js';

/**
 * Uma chamada ao Claude por item. O contrato de saída é garantido pelo
 * structured output do próprio SDK (`output_config.format`), então não há
 * regex nem JSON.parse a mão — mas o parse defensivo continua: se vier fora do
 * formato, o `process` marca o delivery como falho e segue.
 */
const RespostaScorer = z.object({
  score: z
    .number()
    .describe('0 a 10: o quanto este item merece virar vídeo para ESTA criadora'),
  motivo: z.string().describe('Uma linha explicando a nota'),
  resumo: z.string().describe('2 a 3 linhas com os pontos mais interessantes do item'),
  gancho: z.string().describe('O ângulo/abertura sugerido para o vídeo, em uma frase'),
});

export type RespostaScorer = z.infer<typeof RespostaScorer>;

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

const cliente = new Anthropic({ apiKey: config.anthropic.apiKey });

/** Corta o texto do item para não estourar contexto com uma matéria gigante. */
const LIMITE_TEXTO = 12_000;

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

Responda sempre em português do Brasil.`;

function montarConteudoItem(item: Pick<Item, 'titulo' | 'texto' | 'autor' | 'publicado_em' | 'url'>, nomeFonte: string): string {
  const texto = (item.texto ?? '').trim().slice(0, LIMITE_TEXTO);

  return [
    `Fonte: ${nomeFonte}`,
    item.autor ? `Autor: ${item.autor}` : null,
    item.publicado_em ? `Publicado em: ${item.publicado_em}` : null,
    `URL: ${item.url}`,
    '',
    `Título: ${item.titulo}`,
    '',
    texto ? `Conteúdo:\n${texto}` : '(o item não trouxe corpo de texto — avalie pelo título e pela fonte)',
  ]
    .filter((linha) => linha !== null)
    .join('\n');
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

  let resposta;
  try {
    resposta = await cliente.messages.parse({
      model: config.anthropic.modelo,
      max_tokens: 8000,
      // O prefixo (instruções + perfil da criadora) é idêntico em toda chamada;
      // o item vem depois, no turno do usuário. Cacheia bem enquanto o perfil não muda.
      system: [
        { type: 'text', text: INSTRUCOES },
        { type: 'text', text: perfil, cache_control: { type: 'ephemeral' } },
      ],
      thinking: { type: 'adaptive' },
      output_config: {
        format: zodOutputFormat(RespostaScorer),
        effort: config.anthropic.effort,
      },
      messages: [{ role: 'user', content: montarConteudoItem(item, nomeFonte) }],
    });
  } catch (causa) {
    throw new ErroScorer(
      `chamada ao Claude falhou: ${causa instanceof Error ? causa.message : String(causa)}`,
      causa,
    );
  }

  // Classificador de segurança recusou o item (acontece com notícia violenta, por ex.).
  if (resposta.stop_reason === 'refusal') {
    throw new ErroScorer(
      `modelo recusou avaliar o item (${resposta.stop_details?.category ?? 'sem categoria'})`,
    );
  }

  if (resposta.stop_reason === 'max_tokens') {
    throw new ErroScorer('resposta truncada em max_tokens');
  }

  const saida = resposta.parsed_output;
  if (!saida) {
    throw new ErroScorer('resposta fora do formato esperado (parsed_output vazio)');
  }

  return {
    // O modelo é instruído a dar 0-10, mas a nota é o eixo de toda a calibragem:
    // um valor fora da faixa arredondaria errado no resto do sistema.
    score: Math.min(10, Math.max(0, Math.round(saida.score))),
    motivo: saida.motivo.trim(),
    resumo: saida.resumo.trim(),
    gancho: saida.gancho.trim(),
  };
}
