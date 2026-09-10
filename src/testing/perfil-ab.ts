/**
 * Compara o `perfil_texto` atual da criadora com um candidato, pontuando os
 * MESMOS itens com cada um. Não grava nada.
 *
 *   npx tsx src/testing/perfil-ab.ts 5547999936996
 */
import { pontuar } from '../core/scorer.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

const CANDIDATO = `Público e nicho: fala majoritariamente com mulheres de 18 a 45 anos que gostam de filmes, séries e livros de romance. Comunidade BookTok / bookgram brasileira.

COBRE — o que a faz querer gravar:
Novidade sobre filme, série ou livro de ROMANCE: anúncio de adaptação de livro para as telas, trailer novo, data de estreia, escalação de elenco, e fofoca de bastidor do elenco desses títulos. Também vale casal do momento, química entre protagonistas e o que está bombando em romance no streaming.
Vale igualmente: lançamento e continuação de livro de romance, novidade de autora (Anna Todd, Elle Kennedy, Freida McFadden, Mercedes Ron e afins), evento literário como a Bienal do Livro, e fofoca sobre a vida real dos atores de adaptações — quem namora quem, atrito entre elenco, ator que apagou foto da coadjuvante.

NÃO COBRE — o critério é excludente, não uma lista:
Se o item não for sobre filme, série, livro, fofoca ou qualquer assunto ligado a ROMANCE, ela não grava — por mais relevante que seja para o público geral de cinema. Ficam de fora: terror, ação sem núcleo romântico, games, documentário, premiação técnica, notícia de mercado e bastidor de indústria (contratos, bilheteria, executivos, prêmios estrangeiros). Na dúvida, se o romance não é o centro do item, a nota é baixa.`;

const whatsapp = process.argv[2] ?? '5547999936996';

const { data: cs, error: e1 } = await db.from('creators').select('*').eq('whatsapp', whatsapp).single();
if (e1) throw new Error(e1.message);
const creator = cs as Creator;

const { data, error } = await db
  .from('items')
  .select('*, sources(nome)')
  .order('coletado_em', { ascending: false })
  .limit(14);
if (error) throw new Error(error.message);

type Linha = Item & { sources: { nome: string } | { nome: string }[] | null };
const itens = (data ?? []) as unknown as Linha[];

console.log(`\ncriadora: ${creator.nome}`);
console.log(`perfil atual: ${creator.perfil_texto.length} chars | candidato: ${CANDIDATO.length} chars`);
console.log(`\n${itens.length} itens\n`);
console.log('ATUAL  NOVO   Δ   fonte / título');
console.log('─'.repeat(100));

const notas: { atual: number; novo: number }[] = [];

for (const bruto of itens) {
  const { sources, ...item } = bruto;
  const fonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  const capturar = async (perfil: string) => {
    try {
      return { ok: await pontuar({ creator: { ...creator, perfil_texto: perfil }, item, nomeFonte: fonte }) };
    } catch (e) {
      return { erro: e instanceof Error ? e.message : String(e) };
    }
  };

  // Sequencial de propósito: em paralelo, a OpenRouter soma as requisições em
  // voo contra o saldo e recusa com 402 mesmo havendo crédito para cada uma.
  const ra = await capturar(creator.perfil_texto);
  const rn = await capturar(CANDIDATO);
  const a = ra.ok;
  const n = rn.ok;
  if (!a || !n) {
    console.log(`  FALHOU ${item.titulo.slice(0, 44)}`);
    if (ra.erro) console.log(`     atual: ${ra.erro.slice(0, 130)}`);
    if (rn.erro) console.log(`     novo : ${rn.erro.slice(0, 130)}`);
    continue;
  }

  notas.push({ atual: a.score, novo: n.score });
  const d = n.score - a.score;
  console.log(
    `  ${String(a.score).padStart(2)}     ${String(n.score).padStart(2)}   ${(d > 0 ? `+${d}` : d < 0 ? `${d}` : ' 0').padStart(3)}  ` +
      `${fonte.slice(0, 20).padEnd(20)} ${item.titulo.slice(0, 50)}`,
  );
  if (n.score >= 7) console.log(`         gancho novo: "${n.gancho.slice(0, 88)}"`);
}

/** Desvio padrão: quanto as notas se espalham. Sem espalhamento não há corte possível. */
const espalhamento = (xs: number[]) => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

const atual = notas.map((n) => n.atual);
const novo = notas.map((n) => n.novo);
console.log('─'.repeat(100));
console.log(`  espalhamento (desvio padrão)  atual ${espalhamento(atual).toFixed(2)}  →  novo ${espalhamento(novo).toFixed(2)}`);
console.log(`  itens com nota >= 7           atual ${atual.filter((s) => s >= 7).length}  →  novo ${novo.filter((s) => s >= 7).length}`);
console.log(`  itens com nota <= 2           atual ${atual.filter((s) => s <= 2).length}  →  novo ${novo.filter((s) => s <= 2).length}`);
console.log('\n(o alvo é espalhamento maior: topo alto e fundo baixo, com pouca coisa no meio)');
