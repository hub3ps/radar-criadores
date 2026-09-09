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

/** Remove duplicatas dentro do próprio lote, antes mesmo de consultar o banco. */
export function dedupePorHash<T extends { url: string }>(itens: T[]): (T & { url_hash: string })[] {
  const vistos = new Set<string>();
  const saida: (T & { url_hash: string })[] = [];

  for (const item of itens) {
    const url_hash = hashUrl(item.url);
    if (vistos.has(url_hash)) continue;
    vistos.add(url_hash);
    saida.push({ ...item, url_hash });
  }

  return saida;
}
