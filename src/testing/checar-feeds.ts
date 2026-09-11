/**
 * Verifica candidatos a fonte: acha o feed, conta o volume e mostra amostra.
 *   npx tsx src/testing/checar-feeds.ts site1 site2 ...
 */
import Parser from 'rss-parser';
import { descobrirFeed } from '../collectors/descoberta.js';

const parser = new Parser({
  timeout: 15_000,
  headers: {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
});

for (const alvo of process.argv.slice(2)) {
  const achado = await descobrirFeed(alvo);
  if (!achado) {
    console.log(`  SEM RSS   ${alvo}\n`);
    continue;
  }

  try {
    const feed = await parser.parseURL(achado.feed);
    const itens = feed.items ?? [];
    const datas = itens
      .map((i) => new Date(i.isoDate ?? i.pubDate ?? 0).getTime())
      .filter((t) => t > 0)
      .sort((a, b) => b - a);

    const dias = datas.length > 1 ? (datas[0]! - datas.at(-1)!) / 86_400_000 : 0;
    const porDia = dias > 0.1 ? (datas.length / dias).toFixed(0) : '?';

    console.log(`  OK        ${alvo}`);
    console.log(`            feed: ${achado.feed}`);
    console.log(`            ${itens.length} itens no feed · ~${porDia}/dia`);
    for (const i of itens.slice(0, 4)) console.log(`            · ${(i.title ?? '').slice(0, 72)}`);
    console.log();
  } catch {
    console.log(`  OK        ${alvo} — feed achado (${achado.feed}) mas não parseou\n`);
  }
}
