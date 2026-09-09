/** Percorre o cadastro com 5 sites, incluindo um sem RSS. Não envia WhatsApp. */
import { db } from '../db/supabase.js';
import { config } from '../config.js';
import { iniciar, onboardingDe, responder } from '../delivery/onboarding.js';

const NUM = '5511900000001';

async function limpar() {
  const o = await onboardingDe(NUM);
  if (o?.creator_id) await db.from('creators').delete().eq('id', o.creator_id);
  await db.from('onboardings').delete().eq('whatsapp', NUM);
  await db.from('convites').delete().eq('whatsapp', NUM);
}
const bot = (t: string | null) => console.log(t ? t.split('\n').map((l) => '  │ ' + l).join('\n') + '\n' : '  [sem resposta]\n');
const ela = (t: string) => console.log(`  ELA ▶ ${t}\n`);

await limpar();
console.log('limite configurado:', config.runtime.cadastroMaxFontes, '\n');
await db.from('convites').insert({ whatsapp: NUM, nome: 'Teste' });
bot((await iniciar(NUM)).texto);

const passos: [string, string][] = [
  ['m1', 'cinema e séries'],
  ['m2', 'Lançamentos, elenco, trailer e data de estreia. Não quero crítica longa.'],
  ['m3', 'deadline.com, variety.com, cinepop.com.br, g1.globo.com e adorocinema.com'],
  ['m4', 'pular'],
  ['m5', 'pular'],
];

for (const [id, texto] of passos) {
  const o = await onboardingDe(NUM);
  if (!o) break;
  ela(texto);
  const t = Date.now();
  bot((await responder(o, texto, id)).texto);
  if (id === 'm3') console.log(`  (etapa de sites levou ${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
}

console.log('=== reenvio do MESMO webhook da etapa de sites (idempotência) ===');
const antes = await onboardingDe(NUM);
const r = await responder(antes!, 'qualquer coisa', 'm5');
console.log('  resposta:', r.texto === null ? 'ignorado (correto)' : 'AVANÇOU — BUG');
console.log('  etapa segue:', (await onboardingDe(NUM))?.etapa, '\n');

const o = await onboardingDe(NUM);
if (o) { ela('sim'); bot((await responder(o, 'sim', 'm6')).texto); }

const f = await onboardingDe(NUM);
if (f?.creator_id) {
  const { data } = await db.from('creator_sources').select('sources(tipo, nome)').eq('creator_id', f.creator_id);
  console.log('fontes vinculadas:');
  for (const l of (data ?? []) as { sources: { tipo: string; nome: string } }[]) console.log(`  ${l.sources.tipo.padEnd(10)} ${l.sources.nome}`);
}
await limpar();
console.log('\n(dados de teste removidos)');
