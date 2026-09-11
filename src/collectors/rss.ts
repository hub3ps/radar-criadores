import Parser from 'rss-parser';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Source } from '../db/types.js';
import type { Collector, OpcoesColeta, RawItem } from './types.js';

const logger = log.com({ coletor: 'rss' });

const parser = new Parser({
  timeout: 15_000,
  // User-agent de navegador e `accept` explícito: o Geek Pop News, entre outros,
  // devolve 406 para agente não reconhecido. Um feed público recusado por causa
  // do nosso cabeçalho é fonte perdida por motivo bobo.
  headers: {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
});

/**
 * Abaixo disso vale buscar o corpo na página.
 * Calibrado em feeds reais: o CinePOP entrega resumos de ~430 chars, o suficiente
 * para passar de um limiar baixo e deixar o scorer com quase nada para trabalhar.
 */
const TAMANHO_MINIMO_CORPO = 800;
const TIMEOUT_CORPO_MS = 8_000;

/** Tags cujo conteúdo nunca é o texto da matéria. */
const BLOCOS_RUIDO =
  /<(script|style|nav|header|footer|aside|form|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Extração de texto sem dependência: tira os blocos de ruído, remove as tags e
 * normaliza o espaço em branco. Não é `readability` — é o suficiente para dar ao
 * scorer mais do que as duas frases do `<description>`, que é o problema real.
 */
export function extrairTexto(html: string): string {
  const corpo = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;

  const linhas = corpo
    .replace(BLOCOS_RUIDO, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(p|div|br|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, código: string) => String.fromCodePoint(Number(código)))
    .replace(/&#x([0-9a-f]+);/gi, (_, código: string) => String.fromCodePoint(parseInt(código, 16)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0);

  const prosa = linhas.filter(ehProsa).join('\n').trim();

  // Se o filtro não deixou nem um parágrafo de pé, o texto provavelmente é curto
  // de verdade (nota rápida, matéria de duas frases) e não uma página cheia de
  // menu. Aí vale mais o texto inteiro com entulho do que quase nada.
  return prosa.length >= 120 ? prosa : linhas.join('\n').trim();
}

/**
 * Separa parágrafo de entulho de navegação.
 *
 * Menu, byline e rodapé são fragmentos curtos sem pontuação final; parágrafo de
 * matéria é longo ou termina em ponto. Sem isso o scorer recebe o menu inteiro
 * do site antes do texto — e no Deadline chegava a começar com o título de outra
 * matéria, o que faz avaliar a notícia errada.
 */
function ehProsa(linha: string): boolean {
  if (linha.length >= 120) return true;
  // Pontuação final já é sinal forte: item de menu quase nunca termina em ponto.
  // O piso de tamanho só descarta migalha do tipo "Leia mais.".
  if (/[.!?…"'\u201d\u2019)]$/.test(linha) && linha.length >= 25) return true;
  return false;
}

/**
 * Busca o corpo do artigo na URL. Muitos feeds entregam só um resumo curto no
 * `<description>`, e o gancho fica fraco quando o scorer só tem isso.
 * Falha em silêncio: o texto do feed continua valendo.
 */
async function buscarCorpo(url: string): Promise<string | null> {
  const abortar = AbortSignal.timeout(TIMEOUT_CORPO_MS);

  try {
    const resposta = await fetch(url, {
      signal: abortar,
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; radar-criadores/0.1; +monitor de novidades)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!resposta.ok) {
      logger.debug('corpo não veio', { url, status: resposta.status });
      return null;
    }

    const tipo = resposta.headers.get('content-type') ?? '';
    if (!tipo.includes('html')) return null;

    const texto = extrairTexto(await resposta.text());
    return texto.length >= TAMANHO_MINIMO_CORPO ? texto : null;
  } catch (erro) {
    logger.debug('falha ao buscar corpo', { url, erro });
    return null;
  }
}

function primeiraData(...candidatos: (string | undefined)[]): string | null {
  for (const bruto of candidatos) {
    if (!bruto) continue;
    const data = new Date(bruto);
    if (!Number.isNaN(data.getTime())) return data.toISOString();
  }
  return null;
}

export const rssCollector: Collector = {
  tipo: 'rss',

  async coletar(fonte: Source, opcoes: OpcoesColeta): Promise<RawItem[]> {
    let feed;
    try {
      feed = await parser.parseURL(fonte.identificador);
    } catch (erro) {
      // Uma fonte fora do ar não pode derrubar a rodada das outras.
      logger.warn('feed inacessível', { fonte: fonte.nome, url: fonte.identificador, erro });
      return [];
    }

    const entradas = (feed.items ?? [])
      .filter((entrada) => Boolean(entrada.link))
      .slice(0, opcoes.limite);

    const itens = await Promise.all(
      entradas.map(async (entrada): Promise<RawItem> => {
        const url = entrada.link as string;

        const doFeed = extrairTexto(
          entrada['content:encoded'] ?? entrada.content ?? entrada.summary ?? entrada.contentSnippet ?? '',
        );

        const texto =
          config.runtime.rssBuscarCorpo && doFeed.length < TAMANHO_MINIMO_CORPO
            ? ((await buscarCorpo(url)) ?? doFeed)
            : doFeed;

        return {
          url,
          titulo: (entrada.title ?? url).trim(),
          texto: texto.length > 0 ? texto : null,
          autor: entrada.creator ?? entrada.author ?? feed.title ?? null,
          publicado_em: primeiraData(entrada.isoDate, entrada.pubDate),
          source_id: fonte.id,
        };
      }),
    );

    logger.debug('feed coletado', { fonte: fonte.nome, itens: itens.length });
    return itens;
  },
};
