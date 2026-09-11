/**
 * Mede a triagem contra o histórico real: roda o modelo barato nos itens que
 * o modelo caro já pontuou e conta quantos itens BONS ela mataria.
 *
 *   npx tsx src/testing/triagem-validar.ts 5547999936996
 */
import { triar } from '../core/triagem.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

/** Corte de envio: acima disto o item chega na criadora. */
const CORTE_ENVIO = 6;

const whatsapp = process.argv[2] ?? '5547999936996';

const { data: cd, error: e1 } = await db.from('creators').select('*').eq('whatsapp', whatsapp).single();
if (e1) throw new Error(e1.message);
const creator = cd as Creator;

const { data, error } = await db
  .from('deliveries')
  .select('score, items(*, sources(nome))')
  .eq('creator_id', creator.id)
  .not('score', 'is', null);
if (error) throw new Error(error.message);

type Linha = { score: number; items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null };
const linhas = (data ?? []) as unknown as Linha[];

console.log(`\ntriagem: ${config.openrouter.modeloTriagem}`);
console.log(`scorer : ${config.openrouter.modelo}`);
console.log(`\n${linhas.length} itens já pontuados pelo scorer completo\n`);

const pares: { opus: number; triagem: number; titulo: string; fonte: string }[] = [];

for (const l of linhas) {
  if (!l.items) continue;
  const { sources, ...item } = l.items;
  const fonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  try {
    const t = await triar({ creator, item, nomeFonte: fonte });
    pares.push({ opus: l.score, triagem: t, titulo: item.titulo, fonte });
    process.stdout.write('.');
  } catch {
    process.stdout.write('x');
  }
}
console.log('\n');

const bons = pares.filter((p) => p.opus >= CORTE_ENVIO);
const ruins = pares.filter((p) => p.opus < CORTE_ENVIO);

console.log(`itens bons (scorer >= ${CORTE_ENVIO}): ${bons.length}   ruins: ${ruins.length}\n`);
console.log('corte    bons perdidos   itens que ainda vão ao Opus   economia');
console.log('─'.repeat(70));

for (const corte of [1, 2, 3, 4, 5]) {
  const perdidos = bons.filter((p) => p.triagem < corte);
  const sobrevivem = pares.filter((p) => p.triagem >= corte).length;
  const economia = (100 * (1 - sobrevivem / pares.length)).toFixed(0);
  const marca = perdidos.length === 0 ? ' ✓' : ` ✗ (${perdidos.map((p) => p.opus).join(',')})`;
  console.log(
    `  ${corte}        ${String(perdidos.length).padStart(2)}${marca.padEnd(22)} ${String(sobrevivem).padStart(3)} de ${pares.length}` +
      `                ${economia}%`,
  );
}

console.log('\nitens bons e a nota que a triagem deu neles:');
for (const p of bons.sort((a, b) => b.opus - a.opus)) {
  const alerta = p.triagem < 4 ? '  ⚠ SERIA CORTADO' : '';
  console.log(`  scorer ${String(p.opus).padStart(2)}  triagem ${String(p.triagem).padStart(2)}  ${p.titulo.slice(0, 52)}${alerta}`);
}
