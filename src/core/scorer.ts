import { z } from 'zod';
import { ErroModelo, extrairJson, interpretar, pedirJson } from './openrouter.js';
import type { Creator, Item } from '../db/types.js';

/**
 * Uma chamada ao modelo por item. O contrato de saída e o parse defensivo
 * moram em `openrouter.ts`; aqui fica só o que é do scoring.
 */
const RespostaScorer = z.object({
  score: z.number().describe('0 a 10: o quanto este item merece virar vídeo para ESTA criadora'),
  motivo: z.string().describe('Uma linha explicando a nota'),
  resumo: z.string().describe('2 a 3 linhas com os pontos mais interessantes do item'),
  gancho: z.string().describe('O ângulo/abertura sugerido para o vídeo, em uma frase'),
});

export type RespostaScorer = z.infer<typeof RespostaScorer>;

/** Mantido para quem já trata este nome; é o erro do cliente do modelo. */
export { ErroModelo as ErroScorer, extrairJson };

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
 * A nota é o eixo de toda a calibragem: um valor fora da faixa, ou com espaço
 * sobrando nos textos, estragaria o resto do sistema silenciosamente.
 */
function normalizar(saida: RespostaScorer): RespostaScorer {
  return {
    score: Math.min(10, Math.max(0, Math.round(saida.score))),
    motivo: saida.motivo.trim(),
    resumo: saida.resumo.trim(),
    gancho: saida.gancho.trim(),
  };
}

/** Valida e normaliza a resposta crua do modelo. Exposto para teste. */
export function interpretarResposta(bruto: string): RespostaScorer {
  return normalizar(interpretar(bruto, RespostaScorer));
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

  const saida = await pedirJson(
    {
      system: `${INSTRUCOES}\n\n---\n\n${perfil}`,
      user: montarConteudoItem(item, nomeFonte),
      nome: 'avaliacao_item',
    },
    RespostaScorer,
  );

  return normalizar(saida);
}
