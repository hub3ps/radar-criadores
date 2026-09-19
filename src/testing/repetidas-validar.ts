/**
 * Mede a checagem de repetição contra o histórico real: repassa, em ordem, as
 * mensagens que ela recebeu, comparando cada uma com o que ela tinha recebido
 * nas 72 h anteriores — o mesmo que o `process` faz com um item recém-pontuado.
 *
 * O gabarito saiu da leitura das 240 mensagens enviadas entre 09/09 e 18/09.
 * O número que importa é o de itens de NAO_REPETE barrados: tem que ser 0,
 * porque novidade barrada por engano ela nunca chega a ver.
 *
 * Só são checados o gabarito e o que foi enviado com a triagem ligada, que é o
 * que representa a produção de hoje. O resto do histórico entra só como lista
 * do que ela já tinha recebido.
 *
 * Gasta o crédito do OpenRouter que o scorer usa. O segundo argumento é o teto
 * em dólares. O custo é ESTIMADO antes de qualquer chamada, pelo tamanho de
 * cada pedido, e o script se recusa a rodar se a estimativa passar do teto.
 * Não dá para confiar no gasto que o OpenRouter informa: ele chega com minutos
 * de atraso, e uma trava baseada nele deixou uma medição custar quase o dobro
 * do que mostrava. Com `gabarito` no terceiro argumento, checa só o gabarito.
 *
 *   npx tsx src/testing/repetidas-validar.ts 5547999936996 1.00
 *   npx tsx src/testing/repetidas-validar.ts 5547999936996 0.50 gabarito
 */
import {
  MAX_TOKENS_RESPOSTA,
  jaRecebida,
  normalizarTitulo,
  preparar,
  type EntradaRepeticao,
  type Recebido,
  type Repeticao,
} from '../core/repetidas.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

const JANELA_HORAS = 72;
const LIMITE_RECEBIDOS = 80;
/**
 * Poucas de cada vez: o OpenRouter reserva crédito por chamada em andamento e,
 * com saldo baixo, recusa as simultâneas com 402 — foi o que zerou metade da
 * primeira medição.
 */
const PARALELO = 3;
/** Quando a triagem foi ligada em produção. */
const TRIAGEM_DESDE = Date.parse('2026-09-11T01:10:00Z');

/**
 * Preço do modelo da triagem (Haiku 4.5), em dólares por token. Se trocar
 * `OPENROUTER_MODELO_TRIAGEM`, atualize aqui.
 */
const PRECO_ENTRADA = 1 / 1_000_000;
const PRECO_SAIDA = 5 / 1_000_000;
/** Português e inglês dão uns 4 caracteres por token; 3 erra para cima, de propósito. */
const CARACTERES_POR_TOKEN = 3;

/** Cada grupo é UM fato. O primeiro a chegar passa; os demais devem ser barrados. */
const MESMO_FATO: string[][] = [
  // mesmo fato, fontes diferentes
  ["RuPaul's Drag Race UK Canceled", "RuPaul's Drag Race UK é CANCELADA"],
  ['Nobody Wants This Season 3', '3ª temporada de Ninguém Quer', 'Já sabemos quando estreia a 3ª temporada de Ninguém Quer'],
  ['American Horror Story Season 13 Trailer', 'Bruxas enfrentam nova ameaça no trailer da 13ª temporada'],
  ['Mr. & Mrs. Smith Adds Yonatan Gebeyehu', 'Ator de Elementary se junta ao elenco'],
  ['Ella Langley Leads CMA Awards', 'CMA Awards 2026'],
  ['Avatar: Seven Havens', 'Confira o novo trailer ÉPICO de Avatar'],
  ['X-Men: Astro de Gen V', 'Asa Germann Lands Role Of Angel'],
  ['The Family Stone Sequel', 'Tudo em Família ganhará SEQUÊNCIA'],
  ['Nicole Wallace Joins Josh Heuston', 'Nicole Wallace vai estrelar'],
  // mesma matéria, mesma fonte, URL editada
  ['Da Magia à Sedução: Feitiço de Amor – Crítica'],
  ['Após desastre nas bilheterias, Supergirl'],
  ['A Garota do Remo: Netflix junta esporte'],
  ['Drink In Low Lies The Land'],
];

/** Mesmo assunto de algo que ela já recebeu, ou só parecido: nenhum pode ser barrado. */
const NAO_REPETE: string[] = [
  'A Garota do Remo – Crítica',
  'A Garota do Remo final explicado',
  'A Garota do Remo terá 2ª temporada',
  'A Garota do Remo: veja idade',
  'Crítica | A Garota do Remo',
  'A Garota do Remo: Série da Netflix é baseada',
  'A Garota do Remo: Criadora revela',
  'Crew Girl Creator Vivian Lin Unpacks',
  'Quando estreia Atraídos pelo Destino 2',
  'O que acontece em Atraídos pelo Destino 2',
  'Atraídos pelo Destino: o que muda',
  'Mercedes Ron enaltece',
  'Crítica | Atraídos pelo Destino',
  'Mercedes Ron relembra',
  'Ester Expósito revela',
  'Você + Eu: Contra o Mundo – Crítica',
  'Você + Eu: Contra o Mundo final explicado',
  'A Boneca – Crítica',
  'A Boneca: Por que',
  'Um Amor Diferente do Seu – Crítica',
  'Um Amor Diferente do Seu: Quando estreiam',
  'Escândalo e Intriga – Crítica',
  'Sol da Minha Vida – Crítica',
  'As Amigas do Clube – Crítica',
  'Lily Collins Bids',
  'Everything We Know About Emily In Paris',
  "Everything We Know About Prime Video's Rose Hill",
  "Everything We Know About Netflix's This Summer",
  "Everything We Know About Netflix's New Pride",
  'TV Show Book Adaptations Arriving In 2026',
  'Hudson Williams Teases',
  'Minka Kelly Reacts',
  'Mariska Hargitay Gets Emmy-Hosting Advice',
  'James Talarico Calls FCC Pressure',
  'Kimmel Play-Acting',
  'NAZA: What The Critics',
  'Gaza Doc NAZA',
  'Escola EM CHAMAS no novo cartaz',
  'Por que Da Magia à Sedução 2',
  'Da Magia à Sedução 2 traz mortes',
  'O cinema está PERDENDO',
  'All The Songs In Practical Magic 2',
  'Maisie Williams Played',
];

/** Casos em que o certo não é óbvio: checados, e listados para revisão à mão. */
const CONFERIR: string[] = [
  'Channel 4 To Combine Drama & Comedy',
  'Conheça a nova série TEEN',
  'Below: Netflix Unveils Official Trailer',
];

const casa = (titulo: string, prefixo: string) =>
  normalizarTitulo(titulo).startsWith(normalizarTitulo(prefixo));

/** Custo de uma chamada, pelo pior caso: resposta usando todo o `max_tokens`. 0 se decide sem modelo. */
function custoEstimado(entrada: EntradaRepeticao): number {
  const preparo = preparar(entrada);
  if ('decidido' in preparo) return 0;
  const tokens = (preparo.system.length + preparo.user.length) / CARACTERES_POR_TOKEN;
  return tokens * PRECO_ENTRADA + MAX_TOKENS_RESPOSTA * PRECO_SAIDA;
}

const whatsapp = process.argv[2] ?? '5547999936996';
const orcamento = Number(process.argv[3] ?? '1.00');
if (!(orcamento > 0)) throw new Error('orçamento inválido: passe o teto em dólares, ex. 1.00');
const soGabarito = process.argv[4] === 'gabarito';

const { data: cd, error: e1 } = await db.from('creators').select('*').eq('whatsapp', whatsapp).single();
if (e1) throw new Error(e1.message);
const creator = cd as Creator;

const { data, error } = await db
  .from('deliveries')
  .select('id, resumo, created_at, items(*, sources(nome))')
  .eq('creator_id', creator.id)
  .eq('status', 'enviado')
  .order('created_at', { ascending: true });
if (error) throw new Error(error.message);

type Linha = {
  id: string;
  resumo: string | null;
  created_at: string;
  items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null;
};

interface Envio {
  id: string;
  resumo: string | null;
  quando: number;
  item: Item;
  fonte: string;
}

const envios: Envio[] = [];
for (const l of (data ?? []) as unknown as Linha[]) {
  if (!l.items) continue;
  const { sources, ...item } = l.items;
  const fonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';
  envios.push({ id: l.id, resumo: l.resumo, quando: new Date(l.created_at).getTime(), item, fonte });
}

/** O que ela tinha recebido quando este item chegou, os mais recentes primeiro. */
function recebidosAntes(i: number): Recebido[] {
  const agora = envios[i]!.quando;
  const desde = agora - JANELA_HORAS * 3_600_000;
  return envios
    .slice(0, i)
    .filter((e) => e.quando >= desde && e.quando < agora)
    .reverse()
    .slice(0, LIMITE_RECEBIDOS)
    .map((e) => ({ id: e.id, titulo: e.item.titulo, resumo: e.resumo, nomeFonte: e.fonte }));
}

const indices = envios.map((_, i) => i);
const doGabarito = (i: number) =>
  [...MESMO_FATO.flat(), ...NAO_REPETE, ...CONFERIR].some((p) => casa(envios[i]!.item.titulo, p));

// O gabarito primeiro: se o orçamento acabar, é o que não pode ficar de fora.
const alvos = [
  ...indices.filter(doGabarito),
  ...(soGabarito ? [] : indices.filter((i) => !doGabarito(i) && envios[i]!.quando >= TRIAGEM_DESDE)),
];

const entradaDe = (i: number): EntradaRepeticao => ({
  novo: { titulo: envios[i]!.item.titulo, resumo: envios[i]!.resumo, nomeFonte: envios[i]!.fonte },
  recebidos: recebidosAntes(i),
});

const previsto = alvos.reduce((soma, i) => soma + custoEstimado(entradaDe(i)), 0);
console.log(`\nmodelo: ${config.openrouter.modeloTriagem}`);
console.log(`${envios.length} mensagens no histórico, ${alvos.length} a checar`);
console.log(`custo estimado: até US$ ${previsto.toFixed(2)}   teto: US$ ${orcamento.toFixed(2)}\n`);

if (previsto > orcamento) {
  console.log('A estimativa passa do teto — nada foi gasto. Suba o teto ou use o modo `gabarito`.');
  process.exit(1);
}

/** undefined = não checado (fora dos alvos). */
const resultados: (Repeticao | null | 'erro' | undefined)[] = new Array(envios.length).fill(undefined);
const mensagensDeErro: string[] = [];
let proximo = 0;
let gasto = 0;

async function checar(i: number): Promise<Repeticao | null> {
  const entrada = entradaDe(i);
  // Cada tentativa conta: a repetida custa de novo.
  gasto += custoEstimado(entrada);
  try {
    return await jaRecebida(entrada);
  } catch {
    // Uma segunda chance depois que as chamadas em andamento assentarem, se couber no teto.
    if (gasto + custoEstimado(entrada) > orcamento) throw new Error('sem orçamento para repetir a chamada');
    await new Promise((r) => setTimeout(r, 3_000));
    gasto += custoEstimado(entrada);
    return jaRecebida(entrada);
  }
}

async function trabalhador(): Promise<void> {
  while (proximo < alvos.length) {
    const i = alvos[proximo++]!;
    try {
      resultados[i] = await checar(i);
      process.stdout.write(resultados[i] ? 'R' : '.');
    } catch (erro) {
      resultados[i] = 'erro';
      mensagensDeErro.push(String(erro).slice(0, 200));
      process.stdout.write('x');
    }
  }
}

await Promise.all(Array.from({ length: PARALELO }, trabalhador));
console.log('\n');

const linha = (i: number) => `[${envios[i]!.fonte}] ${envios[i]!.item.titulo.slice(0, 70)}`;
const repeticaoDe = (i: number) => {
  const r = resultados[i];
  return r && r !== 'erro' ? r : null;
};
const avaliado = (i: number) => resultados[i] !== undefined && resultados[i] !== 'erro';

const vistos = new Set<number>();
let esperadas = 0;
let barradas = 0;

console.log('MESMO FATO — o primeiro passa, os outros devem ser barrados');
console.log('─'.repeat(78));
for (const grupo of MESMO_FATO) {
  const membros = indices.filter((i) => grupo.some((p) => casa(envios[i]!.item.titulo, p)));
  if (membros.length < 2) {
    console.log(`  ⚠ grupo com ${membros.length} mensagem(ns) no histórico: ${grupo[0]}`);
    continue;
  }

  membros.forEach((i, posicao) => {
    vistos.add(i);
    const r = repeticaoDe(i);
    // Chamada que falhou ou não rodou não conta nem como acerto nem como erro.
    if (!avaliado(i)) {
      console.log(`  ? ${resultados[i] === 'erro' ? 'erro' : 'não rodou'}  ${linha(i)}`);
      return;
    }
    if (posicao === 0) {
      console.log(`  ${r ? '✗ BARRADO' : '✓ passou'}     ${linha(i)}`);
      if (r) console.log(`               ← ${r.original.titulo.slice(0, 70)}  (era o primeiro do grupo)`);
      return;
    }
    esperadas += 1;
    if (r) barradas += 1;
    console.log(`  ${r ? '✓ barrado' : '✗ PASSOU'}    ${linha(i)}`);
    if (r) console.log(`               ← ${r.original.titulo.slice(0, 70)}`);
  });
  console.log('');
}

let indevidos = 0;
let checadosNaoRepete = 0;
console.log('NÃO REPETE — nenhum pode ser barrado');
console.log('─'.repeat(78));
for (const prefixo of NAO_REPETE) {
  const membros = indices.filter((i) => casa(envios[i]!.item.titulo, prefixo));
  if (membros.length === 0) console.log(`  ⚠ não encontrado no histórico: ${prefixo}`);

  for (const i of membros) {
    vistos.add(i);
    if (avaliado(i)) checadosNaoRepete += 1;
    const r = repeticaoDe(i);
    if (!r) continue;
    indevidos += 1;
    console.log(`  ✗ BARRADO ${linha(i)}`);
    console.log(`            ← ${r.original.titulo.slice(0, 70)}`);
    console.log(`            manchete lida: ${r.motivo}`);
  }
}
if (indevidos === 0) console.log(`  ✓ nenhum barrado (${checadosNaoRepete} checados)`);

console.log('\nFORA DO GABARITO — barrados, para revisar à mão');
console.log('─'.repeat(78));
let outros = 0;
for (const i of indices) {
  const r = repeticaoDe(i);
  if (!r || vistos.has(i)) continue;
  outros += 1;
  console.log(`  ${linha(i)}`);
  console.log(`    ← [${r.original.nomeFonte}] ${r.original.titulo.slice(0, 70)}`);
  console.log(`    manchete lida: ${r.motivo}`);
}
if (outros === 0) console.log('  nenhum');

const erros = resultados.filter((r) => r === 'erro').length;
console.log('\nRESUMO');
console.log(`  repetições barradas:              ${barradas} de ${esperadas}`);
console.log(`  não-repetição barrada por engano: ${indevidos} de ${checadosNaoRepete}   (tem que ser 0)`);
console.log(`  barrados fora do gabarito:        ${outros}`);
console.log(`  chamadas que falharam:            ${erros}   (em produção, o item passaria)`);
console.log(`  gasto estimado (pior caso):       US$ ${gasto.toFixed(3)}`);
if (mensagensDeErro.length > 0) console.log(`\n  exemplo de erro: ${mensagensDeErro[0]}`);
