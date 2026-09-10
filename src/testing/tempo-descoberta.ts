import { descobrirFeed } from '../collectors/descoberta.js';
import Parser from 'rss-parser';
const parser = new Parser({ timeout: 15000, headers: { 'user-agent': 'Mozilla/5.0' } });

for (const alvo of process.argv.slice(2)) {
  const r = await descobrirFeed(alvo);
  if (!r) { console.log(`  SEM RSS  ${alvo}`); continue; }
  try {
    const f = await parser.parseURL(r.feed);
    const itens = f.items ?? [];
    const datas = itens.map((i) => new Date(i.isoDate ?? i.pubDate ?? 0).getTime()).filter((t) => t > 0).sort((a, b) => b - a);
    const porDia = datas.length > 1 ? (datas.length / Math.max(1, (datas[0]! - datas[datas.length - 1]!) / 86400000)).toFixed(1) : '?';
    console.log(`  OK  ${alvo.padEnd(30)} ${String(itens.length).padStart(3)} itens  ~${porDia}/dia  ${r.nome.slice(0, 28)}`);
    console.log(`      ex: ${(itens[0]?.title ?? '').slice(0, 80)}`);
  } catch { console.log(`  OK  ${alvo.padEnd(30)} (feed achado, não parseou)`); }
}
