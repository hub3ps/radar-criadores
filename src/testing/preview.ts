/**
 * Mostra as mensagens pendentes exatamente como sairiam no WhatsApp,
 * sem enviar nada. Use antes de soltar o dispatch.
 *
 *   npx tsx src/testing/preview.ts
 */
import { formatarMensagem, normalizarWhatsapp } from '../core/formatter.js';
import { db } from '../db/supabase.js';
import type { Creator, Delivery, Item } from '../db/types.js';

const { data, error } = await db
  .from('deliveries')
  .select('*, items(*, sources(nome)), creators(nome, whatsapp)')
  .eq('status', 'pendente')
  .order('created_at', { ascending: true });

if (error) throw new Error(error.message);

type Linha = Delivery & {
  items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null;
  creators: Pick<Creator, 'nome' | 'whatsapp'> | null;
};

const linhas = (data ?? []) as unknown as Linha[];
console.log(`\n${linhas.length} mensagem(ns) pendente(s)\n`);

for (const bruto of linhas) {
  const { items, creators, ...delivery } = bruto;
  if (!items || !creators) continue;

  const { sources, ...item } = items;
  const fonte = Array.isArray(sources) ? sources[0] : sources;

  const texto = formatarMensagem({ delivery, item, nomeFonte: fonte?.nome ?? '?' });

  console.log('┌─ para ' + normalizarWhatsapp(creators.whatsapp) + ' ' + '─'.repeat(46));
  for (const linha of texto.split('\n')) console.log('│ ' + linha);
  console.log('└' + '─'.repeat(60) + '\n');
}
