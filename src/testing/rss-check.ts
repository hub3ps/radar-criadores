/**
 * Confere um feed RSS sem banco e sem gastar nada com o scorer.
 * Útil antes de cadastrar uma fonte nova — mostra o que o coletor extrai dela.
 *
 *   npx tsx src/testing/rss-check.ts https://exemplo.com/feed
 */
import './env.js';
import { rssCollector } from '../collectors/rss.js';
import { dedupePorHash } from '../core/dedupe.js';
import type { Source } from '../db/types.js';

const fonte: Source = {
  id: 'fonte-de-teste',
  tipo: 'rss',
  identificador: process.argv[2] ?? 'https://g1.globo.com/rss/g1/tecnologia/',
  nome: 'G1 Tecnologia',
  ativo: true,
  ultima_coleta: null,
  created_at: new Date().toISOString(),
};

const itens = await rssCollector.coletar(fonte, { limite: 3 });
const comHash = dedupePorHash(itens);

console.log(`\nitens coletados: ${comHash.length}\n`);
for (const item of comHash) {
  console.log('titulo      :', item.titulo);
  console.log('url         :', item.url);
  console.log('autor       :', item.autor);
  console.log('publicado_em:', item.publicado_em);
  console.log('url_hash    :', item.url_hash.slice(0, 16), '...');
  console.log('texto       :', (item.texto ?? '').length, 'chars ->', JSON.stringify((item.texto ?? '').slice(0, 160)));
  console.log('---');
}
