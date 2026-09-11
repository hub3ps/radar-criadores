/**
 * Repontua itens já avaliados e mostra a mensagem COMO ela chegaria hoje.
 * Não grava nada e não envia nada.
 *
 *   npx tsx src/testing/mensagem-preview.ts 5547999936996 6
 */
import { pontuar } from '../core/scorer.js';
import { formatarMensagem } from '../core/formatter.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

const whatsapp = process.argv[2] ?? '5547999936996';
const notaMinima = Number(process.argv[3] ?? 6);

const { data: cd, error: e1 } = await db.from('creators').select('*').eq('whatsapp', whatsapp).single();
if (e1) throw new Error(e1.message);
const creator = cd as Creator;

const { data, error } = await db
  .from('deliveries')
  .select('score, gancho, items(*, sources(nome))')
  .eq('creator_id', creator.id)
  .gte('score', notaMinima)
  .order('score', { ascending: false })
  .limit(4);
if (error) throw new Error(error.message);

type Linha = {
  score: number;
  gancho: string | null;
  items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null;
};

for (const l of ((data ?? []) as unknown as Linha[])) {
  if (!l.items) continue;
  const { sources, ...item } = l.items;
  const nomeFonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  const nota = await pontuar({ creator, item, nomeFonte });
  const texto = formatarMensagem({ delivery: nota, item, nomeFonte });

  console.log(`\n${'═'.repeat(74)}`);
  console.log(`nota ${l.score} → ${nota.score}   ${item.titulo.slice(0, 56)}`);
  console.log(`gancho antigo: "${(l.gancho ?? '').slice(0, 100)}"`);
  console.log('─'.repeat(74));
  for (const linha of texto.split('\n')) console.log('│ ' + linha);
}
