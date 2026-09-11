/**
 * Repontua deliveries pendentes com o prompt e o perfil ATUAIS, e grava.
 * Útil depois de mexer no scorer ou no perfil_texto: o que já estava na fila
 * foi avaliado com as regras antigas.
 *
 *   npx tsx src/testing/repontuar.ts <id> [<id>...]
 */
import { pontuar } from '../core/scorer.js';
import { db } from '../db/supabase.js';
import type { Creator, Item } from '../db/types.js';

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('informe ao menos um id de delivery');

const { data, error } = await db
  .from('deliveries')
  .select('id, creator_id, score, gancho, items(*, sources(nome)), creators(*)')
  .in('id', ids);
if (error) throw new Error(error.message);

type Linha = {
  id: string;
  score: number | null;
  gancho: string | null;
  items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null;
  creators: Creator | Creator[] | null;
};

for (const bruto of ((data ?? []) as unknown as Linha[])) {
  if (!bruto.items || !bruto.creators) continue;
  const creator = Array.isArray(bruto.creators) ? bruto.creators[0]! : bruto.creators;
  const { sources, ...item } = bruto.items;
  const nomeFonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  const nota = await pontuar({ creator, item, nomeFonte });

  const { error: e } = await db
    .from('deliveries')
    .update({
      score: nota.score,
      motivo_score: nota.motivo,
      resumo: nota.resumo,
      gancho: nota.gancho,
    })
    .eq('id', bruto.id);
  if (e) throw new Error(e.message);

  console.log(`\n${item.titulo.slice(0, 60)}`);
  console.log(`  nota ${bruto.score} → ${nota.score}`);
  console.log(`  antes: "${(bruto.gancho ?? '').slice(0, 88)}"`);
  console.log(`  agora: "${nota.gancho.slice(0, 88)}"`);
}
