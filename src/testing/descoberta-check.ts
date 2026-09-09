/** Testa a descoberta de feed contra sites reais: npx tsx src/testing/descoberta-check.ts */
import { descobrirFeed } from '../collectors/descoberta.js';

const alvos = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['deadline.com', 'https://www.adorocinema.com', 'omelete.com.br', 'variety.com', 'g1.globo.com', 'nao-existe-mesmo-xyz.com'];

for (const alvo of alvos) {
  const r = await descobrirFeed(alvo);
  console.log(r ? `  OK   ${alvo.padEnd(32)} -> ${r.nome} | ${r.feed}` : `  SEM  ${alvo}`);
}
