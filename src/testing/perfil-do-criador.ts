/**
 * Busca os últimos posts DO PRÓPRIO criador para entender o estilo dele.
 * No TikTok, também baixa a faixa de legendas — o que é falado no vídeo.
 *
 *   npx tsx src/testing/perfil-do-criador.ts tiktok:melliesmorgana instagram:morganamellies
 */
import { config } from '../config.js';

const LIMITE = 10;

async function apify(actor: string, input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const r = await fetch(`https://api.apify.com/v2/acts/${actor.replace('/', '~')}/run-sync-get-dataset-items`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apify.token}` },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`${actor}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d: unknown = await r.json();
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

/** Baixa a faixa de legenda, preferindo o idioma original do vídeo. */
async function transcricao(video: Record<string, unknown>): Promise<string | null> {
  const cla = video['cla_info'] as Record<string, unknown> | undefined;
  const faixas = (cla?.['caption_infos'] ?? []) as { lang?: string; url?: string }[];
  if (faixas.length === 0) return null;

  const original = (cla?.['original_language_info'] as { lang?: string } | undefined)?.lang;
  const escolhida = faixas.find((f) => f.lang === original) ?? faixas[0];
  if (!escolhida?.url) return null;

  try {
    const r = await fetch(escolhida.url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!r.ok) return null;
    const txt = await r.text();
    return txt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'WEBVTT' && !l.includes('-->') && !/^\d+$/.test(l))
      .join(' ')
      .slice(0, 1200);
  } catch {
    return null;
  }
}

for (const alvo of process.argv.slice(2)) {
  const [rede, handle] = alvo.split(':') as [string, string];
  console.log(`\n${'='.repeat(78)}\n${rede.toUpperCase()} — @${handle}\n${'='.repeat(78)}`);

  try {
    if (rede === 'tiktok') {
      const id = await apify(config.apify.actorTiktok, { usernameToId_username: handle });
      const uid = id.map((r) => r['uid'] ?? r['user_id']).find((v) => typeof v === 'string' && /^\d{5,}$/.test(v));
      if (!uid) { console.log('  não resolvi o userId — perfil existe?'); continue; }

      const bruto = await apify(config.apify.actorTiktok, { userPosts_userId: uid, userPosts_count: LIMITE });
      const posts = ((bruto[0]?.['aweme_list'] ?? []) as Record<string, unknown>[]).slice(0, LIMITE);
      console.log(`${posts.length} posts\n`);

      for (const p of posts) {
        const t = await transcricao((p['video'] ?? {}) as Record<string, unknown>);
        const st = (p['statistics'] ?? {}) as Record<string, number>;
        console.log(`· ${String(p['desc'] ?? '').replace(/\n/g, ' ').slice(0, 130)}`);
        console.log(`  ${st['play_count'] ?? '?'} views · ${st['digg_count'] ?? '?'} likes`);
        console.log(`  falado: ${t ? `"${t.slice(0, 260)}"` : '(sem faixa de legenda)'}\n`);
      }
    } else {
      const posts = await apify(config.apify.actorInstagram, {
        directUrls: [`https://www.instagram.com/${handle}/`],
        resultsType: 'posts',
        resultsLimit: LIMITE,
        addParentData: false,
      });
      console.log(`${posts.length} posts\n`);
      for (const p of posts) {
        console.log(`· [${p['type']}] ${String(p['caption'] ?? '').replace(/\n/g, ' ').slice(0, 200)}`);
        const tags = (p['hashtags'] ?? []) as string[];
        console.log(`  ${p['likesCount'] ?? '?'} likes${tags.length ? ' · #' + tags.slice(0, 8).join(' #') : ''}\n`);
      }
    }
  } catch (e) {
    console.log('  ERRO:', e instanceof Error ? e.message : String(e));
  }
}
