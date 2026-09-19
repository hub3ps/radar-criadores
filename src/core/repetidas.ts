import { z } from 'zod';
import { pedirJson } from './openrouter.js';
import { config } from '../config.js';

/**
 * A mesma notícia chegando de novo por outra fonte.
 *
 * O padrão real: o Deadline publica em inglês e, de 3 a 26 horas depois,
 * CinePOP e Capricho publicam o mesmo fato traduzido e com o título
 * brasileiro — "Throttled" vira "Puro Impulso", "The Family Stone" vira "Tudo
 * em Família". URL, slug e título mudam todos, e a criadora recebia a mesma
 * escalação de elenco duas, três vezes.
 *
 * Comparar palavras do título foi medido nos pares reais e não separa nada:
 * mesmo fato deu de 0,00 a 0,31 de similaridade, e matérias diferentes sobre a
 * mesma série deram de 0,13 a 0,29. Por isso quem decide é o modelo barato,
 * lendo o item novo contra o que ela já recebeu, com o começo do resumo do
 * scorer para entender nomes e obras entre idiomas.
 *
 * A linha é ANÚNCIO, não assunto. Crítica, final explicado, "tudo o que sabemos"
 * e a reação de alguém sobre a mesma série são vídeos diferentes para ela — e
 * ela respondeu 1 em vários desses. Medido no histórico: pedindo ao modelo só
 * "é o mesmo fato?", ele dobrava desdobramentos e apanhados no fato original e
 * barrava 6 de 43 matérias que não eram repetição. Então ele só CLASSIFICA cada
 * lado como anúncio ou não, e a regra "só anúncio repete anúncio" fica aqui no
 * código, onde não depende de ele aplicá-la.
 */
const Tipo = z.enum(['anuncio', 'outro']);

const RespostaRepeticao = z.object({
  manchete_nova: z.string().describe('A manchete do item novo, tirada do título: curta, quem fez o quê'),
  tipo_novo: Tipo.describe('"anuncio" ou "outro"'),
  numero: z.number().describe('O item da lista mais parecido, ou 0 se nenhum fala da mesma obra ou pessoa'),
  tipo_da_lista: Tipo.describe('O tipo desse item da lista; "outro" se numero = 0'),
  mesma_manchete: z.boolean().describe('true só se os dois anunciam o MESMO acontecimento'),
});

type RespostaRepeticao = z.infer<typeof RespostaRepeticao>;

/**
 * O resumo só ajuda a entender nomes e obras — o que a matéria É, o título diz.
 * E é a lista que domina o custo da chamada.
 */
const LIMITE_RESUMO = 300;

const INSTRUCOES = `Você verifica se uma notícia nova REPETE um anúncio que uma criadora de conteúdo já recebeu.

Primeiro vem a lista numerada do que ela já recebeu; depois, o item novo, no mesmo
formato: [fonte] título e, embaixo, o começo de um resumo. Leia cada item pelo
TÍTULO — é ele que diz o que a matéria é. O resumo serve só para entender nomes e
obras, porque o título pode estar em inglês ou usar o nome original.

Responda em cinco campos:
1. "manchete_nova": a manchete do item novo, tirada do título: curta, quem fez o quê.
2. "tipo_novo": "anuncio" ou "outro", conforme abaixo.
3. "numero": o item da lista mais parecido, ou 0 se nenhum fala da mesma obra ou pessoa.
4. "tipo_da_lista": o tipo desse item da lista; "outro" se numero = 0.
5. "mesma_manchete": true só se os dois anunciam o MESMO acontecimento.

"anuncio" é a matéria que dá uma notícia nova:
- escalação de elenco, direção ou roteiro
- data de estreia, trailer, teaser, cartaz ou primeiras imagens
- renovação, cancelamento, continuação ou adaptação anunciada
- indicação, prêmio, recorde, bilheteria
- compra, venda, contrato

"outro" é todo o resto, mesmo quando fala da mesma obra:
- crítica, resenha, análise, "final explicado", "o que acontece", teoria
- apanhado: "tudo o que sabemos", listas, "o que os críticos dizem", guia de estreias
- entrevista, declaração, reação de alguém a uma notícia
- curiosidades, bastidores, recomendação ("série X junta romance e esporte")

"mesma_manchete" compara acontecimentos, não assuntos. É true quando os dois
anunciam o mesmo fato, ainda que em sites diferentes, em idiomas diferentes, com o
título brasileiro da obra, ou com um detalhe a mais ou a menos:
- "Nicole Wallace Joins Josh Heuston In Amazon MGM Romance 'Throttled'" e "Nicole
  Wallace vai estrelar adaptação de Puro Impulso com Josh Heuston" → true: a mesma escalação
- "'Nobody Wants This' Season 3 Sets Fall Release Date" e "3ª temporada de 'Ninguém
  Quer' ganha data de estreia" → true: a mesma data
- "Série X ganha trailer" e "Série X é renovada" → false: dois anúncios diferentes
- "Filme A ganha trailer" e "Filme B ganha trailer" → false: obras diferentes

Na dúvida, "outro" e false. Uma repetição custa uma mensagem a mais; uma novidade
barrada por engano ela nunca chega a ver.

Devolva apenas o objeto JSON com os cinco campos.`;

/** Um delivery que ela já recebeu, ou que já está na fila para ela. */
export interface Recebido {
  /** id do delivery */
  id: string;
  titulo: string;
  resumo: string | null;
  nomeFonte: string;
}

export interface EntradaRepeticao {
  /** O item que acabou de passar pelo scorer, com o resumo que ele escreveu. */
  novo: Omit<Recebido, 'id'>;
  recebidos: readonly Recebido[];
}

export interface Repeticao {
  original: Recebido;
  /** O que foi considerado repetido: a manchete que o modelo leu, ou a republicação. */
  motivo: string;
}

/** Sem acento, aspas nem pontuação: `‘Supergirl’` e `'Supergirl'` são o mesmo título. */
export function normalizarTitulo(titulo: string): string {
  return titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A mesma matéria republicada pela própria fonte: o site trocou a categoria ou
 * editou o slug, a URL mudou e o título ficou. Mesmo site e mesmo título não
 * precisam de modelo — e vale até para crítica, que o modelo nunca barraria.
 */
export function republicada(novo: Omit<Recebido, 'id'>, recebidos: readonly Recebido[]): Recebido | null {
  const titulo = normalizarTitulo(novo.titulo);
  return (
    recebidos.find((r) => r.nomeFonte === novo.nomeFonte && normalizarTitulo(r.titulo) === titulo) ?? null
  );
}

/**
 * "Everything We Know About X So Far" e parentes. O modelo lia esses como
 * anúncio mesmo com a instrução dizendo o contrário: o resumo do scorer abre
 * pela novidade mais recente ("estreia em 3 de dezembro") e vencia o título. O
 * Deadline publica um por semana, e ela respondeu 1 em vários.
 */
const APANHADO = /^(everything we know|what we know|what to expect|tudo (o )?que (ja )?sabemos|o que (ja )?sabemos|o que esperar)\b/;

/** Apanhado não repete nada, nem é repetido: nem vai ao modelo. Exposto para teste. */
export function ehApanhado(titulo: string): boolean {
  return APANHADO.test(normalizarTitulo(titulo));
}

/** `[Fonte] Título` e, embaixo, o começo do resumo. O item novo usa o mesmo formato. */
function formatar(rotulo: string, r: Omit<Recebido, 'id'>): string {
  const resumo = (r.resumo ?? '').trim().slice(0, LIMITE_RESUMO);
  const cabecalho = `${rotulo}[${r.nomeFonte}] ${r.titulo}`;
  return resumo ? `${cabecalho}\n   ${resumo}` : cabecalho;
}

/** A lista que o modelo lê, numerada a partir de 1. Exposto para teste. */
export function montarLista(recebidos: readonly Recebido[]): string {
  return recebidos.map((r, i) => formatar(`${i + 1}. `, r)).join('\n');
}

/**
 * Traduz o número devolvido para o delivery original.
 *
 * Número fora da lista é tratado como "não repete": na dúvida o item passa,
 * pela mesma razão das instruções. Exposto para teste.
 */
export function escolhido(numero: number, recebidos: readonly Recebido[]): Recebido | null {
  const n = Math.round(numero);
  if (!Number.isFinite(n) || n < 1 || n > recebidos.length) return null;
  return recebidos[n - 1] ?? null;
}

/**
 * A decisão, a partir da resposta do modelo. Só anúncio repete anúncio: o
 * modelo diz o tipo de cada lado, e a regra é aplicada aqui. Exposto para teste.
 */
export function decidir(saida: RespostaRepeticao, recebidos: readonly Recebido[]): Recebido | null {
  const anuncios = saida.tipo_novo === 'anuncio' && saida.tipo_da_lista === 'anuncio';
  if (!anuncios || !saida.mesma_manchete) return null;
  return escolhido(saida.numero, recebidos);
}

/** Teto da resposta: cinco campos curtos. */
export const MAX_TOKENS_RESPOSTA = 300;

export type Preparo =
  | { decidido: Repeticao | null }
  | { system: string; user: string; candidatos: Recebido[] };

/**
 * O pedido que vai ao modelo, ou a decisão quando ela sai sem ele. Separado
 * para o script de validação estimar o custo ANTES de gastar — o gasto que o
 * OpenRouter informa chega com minutos de atraso.
 */
export function preparar(entrada: EntradaRepeticao): Preparo {
  const { novo, recebidos } = entrada;
  if (recebidos.length === 0) return { decidido: null };

  const mesmaMateria = republicada(novo, recebidos);
  if (mesmaMateria) {
    return { decidido: { original: mesmaMateria, motivo: 'a mesma matéria, republicada pela fonte' } };
  }

  if (ehApanhado(novo.titulo)) return { decidido: null };
  const candidatos = recebidos.filter((r) => !ehApanhado(r.titulo));
  if (candidatos.length === 0) return { decidido: null };

  return {
    system: INSTRUCOES,
    user: `O que ela já recebeu:\n${montarLista(candidatos)}\n\n---\n\nItem novo:\n${formatar('', novo)}`,
    candidatos,
  };
}

/**
 * O delivery que já levou este mesmo anúncio até ela, ou `null`.
 * Lança `ErroModelo` como a triagem; quem chama decide deixar passar.
 */
export async function jaRecebida(entrada: EntradaRepeticao): Promise<Repeticao | null> {
  const preparo = preparar(entrada);
  if ('decidido' in preparo) return preparo.decidido;

  const saida = await pedirJson(
    {
      system: preparo.system,
      user: preparo.user,
      nome: 'repeticao_item',
      modelo: config.openrouter.modeloTriagem,
      maxTokens: MAX_TOKENS_RESPOSTA,
    },
    RespostaRepeticao,
  );

  const original = decidir(saida, preparo.candidatos);
  return original ? { original, motivo: saida.manchete_nova.trim() } : null;
}
