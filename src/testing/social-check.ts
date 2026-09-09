/**
 * Roda o coletor social de verdade, ignorando o SOCIAL_DRY_RUN. Custa centavos.
 *   npx tsx src/testing/social-check.ts tiktok netflixbrasil
 */
import { criarColetorSocial } from '../collectors/social/base.js';
import { apifyProvider } from '../collectors/social/apify.js';
import type { Source } from '../db/types.js';

const rede = (process.argv[2] ?? 'tiktok') as 'instagram' | 'tiktok';
const handle = process.argv[3] ?? 'netflixbrasil';

const fonte: Source = {
  id: 'teste', tipo: rede, identificador: handle, nome: `@${handle}`,
  ativo: true, ultima_coleta: null, created_at: new Date().toISOString(),
};

const itens = await criarColetorSocial(rede, apifyProvider).coletar(fonte, { limite: 3 });
console.log(`\n${itens.length} item(ns) normalizado(s)\n`);
for (const i of itens) {
  console.log('  url         :', i.url);
  console.log('  titulo      :', i.titulo.slice(0, 90));
  console.log('  autor       :', i.autor);
  console.log('  publicado_em:', i.publicado_em);
  console.log('  texto       :', (i.texto ?? '').length, 'chars');
  console.log('  ---');
}
