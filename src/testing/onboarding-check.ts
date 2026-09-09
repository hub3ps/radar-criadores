/** Percorre o cadastro inteiro com um número fictício. Não envia WhatsApp. */
import { db } from '../db/supabase.js';
import { iniciar, onboardingDe, responder } from '../delivery/onboarding.js';

const NUM = '5511900000001';

async function limpar() {
  const o = await onboardingDe(NUM);
  if (o?.creator_id) await db.from('creators').delete().eq('id', o.creator_id);
  await db.from('onboardings').delete().eq('whatsapp', NUM);
  await db.from('convites').delete().eq('whatsapp', NUM);
}

function bot(t: string | null) {
  if (!t) return console.log('  [bot não respondeu]\n');
  console.log(t.split('\n').map((l) => '  │ ' + l).join('\n') + '\n');
}
function ela(t: string) { console.log(`  ELA ▶ ${t}\n`); }

await limpar();

console.log('=== 1) número NÃO convidado ===');
bot((await iniciar(NUM)).texto);

console.log('=== 2) com convite ===');
await db.from('convites').insert({ whatsapp: NUM, nome: 'Morgana (teste)' });
await db.from('onboardings').delete().eq('whatsapp', NUM);
bot((await iniciar(NUM)).texto);

const passos = [
  'cinema e séries',
  'Faço vídeos curtos sobre lançamentos de filme e série. Gosto de anúncio de elenco, trailer novo, data de estreia e bilheteria. Não gosto de crítica longa nem de fofoca de famoso.',
  'quero o deadline.com e também o adorocinema',
  '@variety e @netflixbrasil',
  'pular',
];

for (const texto of passos) {
  const o = await onboardingDe(NUM);
  if (!o) break;
  ela(texto);
  bot((await responder(o, texto)).texto);
}

console.log('=== confirmando ===');
const o = await onboardingDe(NUM);
if (o) { ela('sim'); bot((await responder(o, 'sim')).texto); }

const final = await onboardingDe(NUM);
console.log('=== resultado no banco ===');
console.log('  etapa:', final?.etapa, '| creator_id:', final?.creator_id ? 'criado' : 'AUSENTE');
if (final?.creator_id) {
  const { data } = await db.from('creator_sources').select('sources(tipo, nome, identificador)').eq('creator_id', final.creator_id);
  for (const l of (data ?? []) as { sources: { tipo: string; nome: string; identificador: string } }[]) {
    console.log(`  fonte: ${l.sources.tipo.padEnd(10)} ${l.sources.nome} -> ${l.sources.identificador}`);
  }
}
await limpar();
console.log('\n  (dados de teste removidos)');
