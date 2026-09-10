import { createHash } from 'node:crypto';

/**
 * Parâmetros de rastreamento que não mudam o conteúdo da página.
 * A mesma matéria compartilhada por dois caminhos chega com utm_ diferente e,
 * sem isso, viraria dois itens.
 */
const PARAMS_DESCARTAVEIS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^igsh$/i,
  /^mc_(cid|eid)$/i,
  /^_hs(enc|mi)$/i,
  /^ref$/i,
  /^referrer$/i,
  /^source$/i,
  /^cmpid$/i,
  /^xtor$/i,
];

const PORTA_PADRAO: Record<string, string> = { 'http:': '80', 'https:': '443' };

/**
 * Reduz a URL à forma que identifica o conteúdo: sem fragmento, sem parâmetros
 * de rastreamento, host minúsculo, sem `www.`, sem barra final.
 *
 * Se a URL for inválida, devolve a string original com as pontas aparadas —
 * um handle de rede social, por exemplo, não é URL e ainda assim precisa de hash.
 */
export function canonicalizarUrl(bruta: string): string {
  const texto = bruta.trim();

  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return texto;
  }

  url.hash = '';
  url.username = '';
  url.password = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  if (url.port === PORTA_PADRAO[url.protocol]) url.port = '';

  for (const chave of [...url.searchParams.keys()]) {
    if (PARAMS_DESCARTAVEIS.some((padrao) => padrao.test(chave))) {
      url.searchParams.delete(chave);
    }
  }
  // Ordem dos parâmetros não muda o conteúdo, mas mudaria o hash.
  url.searchParams.sort();

  let saida = url.toString();
  if (saida.endsWith('?')) saida = saida.slice(0, -1);
  // Barra final só é removida quando há caminho — `https://site.com/` vira `https://site.com`.
  if (saida.endsWith('/') && url.pathname !== '/') saida = saida.slice(0, -1);
  if (url.pathname === '/' && !url.search) saida = saida.replace(/\/$/, '');

  return saida;
}

/** sha256 hex da URL canonicalizada. É o que garante o unique em `items.url_hash`. */
export function hashUrl(bruta: string): string {
  return createHash('sha256').update(canonicalizarUrl(bruta)).digest('hex');
}

/**
 * Último segmento do caminho — o "slug" do artigo.
 *
 * Muitos sites publicam a MESMA matéria sob categorias diferentes:
 * `/cultura-pop/a-garota-do-remo-netflix/` e `/series/a-garota-do-remo-netflix/`
 * são a mesma coisa com URLs distintas. O `url_hash` não pega isso, e a criadora
 * recebe o item duas vezes — além de pagarmos o scorer duas vezes.
 *
 * Devolve `null` quando não há slug utilizável (raiz do site, ou slug curto
 * demais para ser identificador confiável, como `/p/1`).
 */
export function slugDaUrl(bruta: string): string | null {
  let url: URL;
  try {
    url = new URL(canonicalizarUrl(bruta));
  } catch {
    return null;
  }

  const partes = url.pathname.split('/').filter((p) => p !== '');
  const slug = partes.at(-1);
  if (!slug || slug.length < 12) return null;

  return slug.toLowerCase();
}

/**
 * Remove duplicatas dentro do próprio lote, antes mesmo de consultar o banco.
 * Considera duplicata tanto a URL igual quanto o mesmo slug em caminho diferente.
 */
export function dedupePorHash<T extends { url: string }>(itens: T[]): (T & { url_hash: string })[] {
  const hashes = new Set<string>();
  const slugs = new Set<string>();
  const saida: (T & { url_hash: string })[] = [];

  for (const item of itens) {
    const url_hash = hashUrl(item.url);
    if (hashes.has(url_hash)) continue;

    const slug = slugDaUrl(item.url);
    if (slug !== null && slugs.has(slug)) continue;

    hashes.add(url_hash);
    if (slug !== null) slugs.add(slug);
    saida.push({ ...item, url_hash });
  }

  return saida;
}
