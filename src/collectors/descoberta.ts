import Parser from 'rss-parser';
import { log } from '../logger.js';

/**
 * Acha o feed RSS de um site.
 *
 * Ela vai dizer "acompanha o Deadline" ou colar a home; o coletor precisa da URL
 * do feed. E nem todo site tem um — o AdoroCinema, por exemplo, não oferece RSS.
 * Quando não achamos, quem chama avisa e pede outro site, em vez de cadastrar
 * uma fonte morta.
 */
const logger = log.com({ componente: 'descoberta' });

const TIMEOUT_MS = 12_000;
// Navegador de verdade: alguns feeds públicos devolvem 406 para agente
// desconhecido. Perder uma fonte por causa do cabeçalho seria bobo.
const AGENTE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const parser = new Parser({ timeout: TIMEOUT_MS, headers: { 'user-agent': AGENTE } });

/** Caminhos que a maioria dos CMS usa. Ordem importa: os mais comuns primeiro. */
const CAMINHOS = ['/feed/', '/feed', '/rss', '/rss.xml', '/feed.xml', '/index.xml', '/atom.xml', '/?feed=rss2'];

/**
 * Alguns portais agrupam os feeds sob o nome da marca — o G1 publica em
 * `/rss/g1/` e não declara nada no HTML da home. Derivar do próprio host
 * cobre esse padrão sem fixar domínio nenhum no código.
 */
function caminhosDoHost(url: URL): string[] {
  const marca = url.hostname.replace(/^www\./, '').split('.')[0];
  if (!marca || marca.length < 2) return CAMINHOS;
  return [...CAMINHOS, `/rss/${marca}/`, `/rss/${marca}`];
}

export interface FeedEncontrado {
  feed: string;
  nome: string;
  site: string;
}

/** `deadline.com`, `www.deadline.com/`, `https://deadline.com` → URL normalizada. */
export function normalizarEntrada(bruta: string): URL | null {
  const texto = bruta.trim().replace(/^<|>$/g, '');
  if (texto === '') return null;

  const comEsquema = /^https?:\/\//i.test(texto) ? texto : `https://${texto}`;

  try {
    const url = new URL(comEsquema);
    // Precisa parecer um domínio; "quero o deadline" não é URL.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function buscar(url: string): Promise<{ corpo: string; tipo: string } | null> {
  try {
    const resposta = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': AGENTE, accept: 'application/rss+xml, application/xml, text/xml, text/html, */*' },
    });
    if (!resposta.ok) return null;
    return { corpo: await resposta.text(), tipo: resposta.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

/** Um feed de verdade tem entradas. XML sem `<item>` nem `<entry>` não serve. */
function pareceFeed(corpo: string): boolean {
  return /<(item|entry)\b/i.test(corpo) && /<(rss|feed|rdf:RDF)\b/i.test(corpo);
}

/** Lê o `<link rel="alternate" type="application/rss+xml">` da home. */
export function feedsDeclarados(html: string, base: URL): string[] {
  const encontrados: string[] = [];
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;

    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;

    try {
      encontrados.push(new URL(href, base).toString());
    } catch {
      /* href inválido, ignora */
    }
  }

  return encontrados;
}

/** Confirma que a URL é um feed e devolve o título dele. */
async function validarFeed(url: string, fallbackNome: string): Promise<FeedEncontrado | null> {
  const resposta = await buscar(url);
  if (!resposta || !pareceFeed(resposta.corpo)) return null;

  try {
    const feed = await parser.parseString(resposta.corpo);
    if ((feed.items ?? []).length === 0) return null;

    return {
      feed: url,
      nome: (feed.title ?? fallbackNome).trim().slice(0, 80),
      site: feed.link ?? url,
    };
  } catch {
    return null;
  }
}

/**
 * Tenta, em ordem: a própria URL já é um feed → o feed declarado no HTML →
 * os caminhos convencionais. Devolve null quando o site não publica RSS.
 */
export async function descobrirFeed(entrada: string): Promise<FeedEncontrado | null> {
  const url = normalizarEntrada(entrada);
  if (!url) {
    logger.debug('entrada não parece um site', { entrada });
    return null;
  }

  const nomePadrao = url.hostname.replace(/^www\./, '');

  const direto = await validarFeed(url.toString(), nomePadrao);
  if (direto) return direto;

  // Seção antes do site inteiro. Quem indica "cnnbrasil.com.br/pop" quer a
  // editoria Pop; cair no feed da home traz 482 itens/dia de assunto geral e
  // afoga o que interessa. O feed da seção é a fonte certa, e mais barata.
  const secao = url.pathname.replace(/\/+$/, '');
  if (secao !== '') {
    for (const sufixo of ['/feed/', '/feed', '/rss', '/rss.xml']) {
      const encontrado = await validarFeed(
        new URL(secao + sufixo, url.origin).toString(),
        `${nomePadrao}${secao.replace(/\//g, ' ')}`.trim(),
      );
      if (encontrado) return encontrado;
    }

    // O `<link rel="alternate">` da própria seção costuma apontar para o feed dela.
    const pagina = await buscar(url.toString());
    if (pagina?.tipo.includes('html')) {
      for (const candidato of feedsDeclarados(pagina.corpo, url)) {
        const declarado = await validarFeed(candidato, nomePadrao);
        if (declarado) return declarado;
      }
    }
  }

  const home = await buscar(url.origin);
  if (home?.tipo.includes('html')) {
    for (const candidato of feedsDeclarados(home.corpo, url)) {
      const declarado = await validarFeed(candidato, nomePadrao);
      if (declarado) return declarado;
    }
  }

  for (const caminho of caminhosDoHost(url)) {
    const encontrado = await validarFeed(new URL(caminho, url.origin).toString(), nomePadrao);
    if (encontrado) return encontrado;
  }

  logger.info('site sem RSS', { site: url.hostname });
  return null;
}
