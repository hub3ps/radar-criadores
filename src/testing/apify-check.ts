/**
 * Uma chamada real à Apify para conferir o mapeamento de campos.
 * Ignora o SOCIAL_DRY_RUN de propósito. Custa alguns centavos.
 *   npx tsx src/testing/apify-check.ts instagram netflixbrasil
 */
import { config } from '../config.js';
import { normalizarRegistro } from '../collectors/social/apify.js';

const rede = (process.argv[2] ?? 'instagram') as 'instagram' | 'tiktok';
const handle = process.argv[3] ?? 'netflixbrasil';
const actor = rede === 'instagram' ? config.apify.actorInstagram : config.apify.actorTiktok;

const input =
  rede === 'instagram'
    ? { directUrls: [`https://www.instagram.com/${handle}/`], resultsType: 'posts', resultsLimit: 3, addParentData: false }
    : { username: handle, count: 3, profiles: [handle], resultsPerPage: 3 };

console.log(`chamando ${actor} para @${handle} (limite 3)...\n`);

const r = await fetch(`https://api.apify.com/v2/acts/${actor.replace('/', '~')}/run-sync-get-dataset-items`, {
  method: 'POST',
  signal: AbortSignal.timeout(180_000),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apify.token}` },
  body: JSON.stringify(input),
});

if (!r.ok) {
  console.log('ERRO HTTP', r.status, (await r.text()).slice(0, 600));
  process.exit(1);
}

const dados = (await r.json()) as unknown;
if (!Array.isArray(dados)) { console.log('não veio lista:', JSON.stringify(dados).slice(0, 400)); process.exit(1); }
console.log(`${dados.length} registro(s)\n`);

const primeiro = dados[0] as Record<string, unknown> | undefined;
if (primeiro) {
  console.log('chaves do 1º registro:');
  console.log('  ' + Object.keys(primeiro).sort().join(', ').slice(0, 700) + '\n');
}

console.log('o que MEU normalizador extrai:');
for (const bruto of dados.slice(0, 3)) {
  const p = normalizarRegistro(bruto as Record<string, unknown>, rede, handle);
  if (!p) { console.log('  DESCARTADO (sem url)'); continue; }
  console.log('  url         :', p.url);
  console.log('  titulo      :', p.titulo.slice(0, 90));
  console.log('  autor       :', p.autor);
  console.log('  publicado_em:', p.publicado_em);
  console.log('  texto       :', (p.texto ?? '').length, 'chars');
  console.log('  ---');
}
