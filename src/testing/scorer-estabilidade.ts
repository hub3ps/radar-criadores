/**
 * Repontua itens já avaliados e compara com a nota guardada.
 *
 * A triagem não toca no scorer, então a nota final não deveria mudar. O que
 * este teste mede é a variação natural do modelo entre execuções — que importa
 * para o corte: um item que oscila entre 5 e 6 passa num dia e some no outro.
 *
 *   npx tsx src/testing/scorer-estabilidade.ts
 */
import { pontuar } from '../core/scorer.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

const whatsapp = process.argv[2] ?? '5547999936996';

const { data: cd, error: e1 } = await db.from('creators').select('*').eq('whatsapp', whatsapp).single();
if (e1) throw new Error(e1.message);
const creator = cd as Creator;

// Os de nota alta e alguns na fronteira do corte, que é onde a oscilação dói.
const { data, error } = await db
  .from('deliveries')
  .select('score, items(*, sources(nome))')
  .eq('creator_id', creator.id)
  .gte('score', Number(process.argv[3] ?? 5))
  .lte('score', Number(process.argv[4] ?? 10))
  .order('score', { ascending: false })
  .limit(12);
if (error) throw new Error(error.message);

type Linha = { score: number; items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null };
const linhas = (data ?? []) as unknown as Linha[];

console.log(`\nrepontuando ${linhas.length} itens na faixa ${process.argv[3] ?? 5}-${process.argv[4] ?? 10}\n`);
console.log('guardada  agora   Δ   título');
console.log('─'.repeat(78));

let iguais = 0;
let mudariamDeLado = 0;
const CORTE = 6;

for (const l of linhas) {
  if (!l.items) continue;
  const { sources, ...item } = l.items;
  const fonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  try {
    const n = await pontuar({ creator, item, nomeFonte: fonte });
    const d = n.score - l.score;
    if (d === 0) iguais += 1;

    // O que realmente importa: o item trocou de lado do corte?
    const antesPassava = l.score >= CORTE;
    const agoraPassa = n.score >= CORTE;
    const virou = antesPassava !== agoraPassa;
    if (virou) mudariamDeLado += 1;

    console.log(
      `   ${String(l.score).padStart(2)}      ${String(n.score).padStart(2)}   ${(d > 0 ? `+${d}` : d < 0 ? `${d}` : ' 0').padStart(3)}  ` +
        `${item.titulo.slice(0, 48)}${virou ? '   ⚠ TROCOU DE LADO DO CORTE' : ''}`,
    );
  } catch (e) {
    console.log(`   ${String(l.score).padStart(2)}      erro  ${e instanceof Error ? e.message.slice(0, 50) : ''}`);
  }
}

console.log('─'.repeat(78));
console.log(`  nota idêntica: ${iguais}/${linhas.length}`);
console.log(`  trocaram de lado do corte ${CORTE}: ${mudariamDeLado}`);
