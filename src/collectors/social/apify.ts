import { config } from '../../config.js';
import { log } from '../../logger.js';
import type { Source } from '../../db/types.js';
import type { PostSocial, SocialProvider } from './provider.js';

const logger = log.com({ provedor: 'apify' });

const API = 'https://api.apify.com/v2';
const TIMEOUT_MS = 120_000;

/** `apify/instagram-scraper` → `apify~instagram-scraper` (é assim que a REST aceita). */
function idDoActor(nome: string): string {
  return nome.replace('/', '~');
}

/** Resolve `a.b.c` dentro de um objeto aninhado. */
function porCaminho(registro: Record<string, unknown>, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((atual, parte) => {
    if (typeof atual !== 'object' || atual === null) return undefined;
    return (atual as Record<string, unknown>)[parte];
  }, registro);
}

/** Lê o primeiro campo presente — actors de terceiros mudam nome de campo sem aviso. */
function campo(registro: Record<string, unknown>, ...caminhos: string[]): string | null {
  for (const caminho of caminhos) {
    const valor = porCaminho(registro, caminho);
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
    if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  }
  return null;
}

/** Aceita ISO, epoch em segundos e epoch em milissegundos. */
function paraIso(bruto: string | null): string | null {
  if (!bruto) return null;

  if (/^\d+$/.test(bruto)) {
    const numero = Number(bruto);
    const ms = numero < 1e12 ? numero * 1000 : numero;
    const data = new Date(ms);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
  }

  const data = new Date(bruto);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/** Primeira linha da legenda vira título; o post inteiro vira texto. */
function tituloDaLegenda(legenda: string | null, handle: string, rede: Source['tipo']): string {
  const primeira = (legenda ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!primeira) return `Novo post de @${handle} no ${rede === 'tiktok' ? 'TikTok' : 'Instagram'}`;
  // 140 contando a reticência, para o título não sequestrar a mensagem.
  return primeira.length > 140 ? `${primeira.slice(0, 139)}…` : primeira;
}

/**
 * Normaliza um registro do dataset da Apify.
 * Registros sem URL são descartados: sem URL não há dedupe nem link na mensagem.
 */
export function normalizarRegistro(
  registro: Record<string, unknown>,
  rede: Source['tipo'],
  handle: string,
): PostSocial | null {
  const url = campo(registro, 'url', 'postUrl', 'webVideoUrl', 'shareUrl', 'link');
  if (!url) return null;

  const legenda = campo(registro, 'caption', 'text', 'desc', 'description', 'title');

  return {
    url,
    titulo: tituloDaLegenda(legenda, handle, rede),
    texto: legenda,
    autor: `@${campo(registro, 'ownerUsername', 'authorMeta.name', 'author.uniqueId', 'uniqueId') ?? handle}`,
    publicado_em: paraIso(
      campo(registro, 'timestamp', 'createTimeISO', 'createTime', 'publishedAt', 'takenAt'),
    ),
  };
}

/** Input do actor, por rede. Se você trocar de actor, é este objeto que muda. */
function montarInput(rede: Source['tipo'], handle: string, limite: number): Record<string, unknown> {
  if (rede === 'instagram') {
    return {
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsType: 'posts',
      resultsLimit: limite,
      addParentData: false,
    };
  }

  return {
    // scraptik/tiktok-api cobra por requisição, não por resultado — puxar 3 ou 30
    // custa o mesmo. O limite aqui é para não inundar o WhatsApp, não para economizar.
    username: handle,
    count: limite,
    profiles: [handle],
    resultsPerPage: limite,
  };
}

export function criarApifyProvider(): SocialProvider {
  return {
    nome: 'apify',

    disponivel(): boolean {
      return config.apify.token.length > 0;
    },

    async buscarPosts(rede, handle, limite): Promise<PostSocial[]> {
      const actor = rede === 'instagram' ? config.apify.actorInstagram : config.apify.actorTiktok;
      const input = montarInput(rede, handle, limite);

      // dry-run: mostra o que seria raspado sem gastar crédito.
      if (config.apify.dryRun) {
        logger.info('dry-run — nada foi chamado na Apify', { rede, handle, actor, limite, input });
        return [];
      }

      if (config.apify.token.length === 0) {
        logger.warn('APIFY_TOKEN ausente — coletor social devolvendo vazio', { rede, handle });
        return [];
      }

      const url = `${API}/acts/${idDoActor(actor)}/run-sync-get-dataset-items`;

      let registros: unknown;
      try {
        const resposta = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apify.token}`,
          },
          body: JSON.stringify(input),
        });

        if (!resposta.ok) {
          logger.warn('actor devolveu erro', {
            rede,
            handle,
            actor,
            status: resposta.status,
            corpo: (await resposta.text()).slice(0, 500),
          });
          return [];
        }

        registros = await resposta.json();
      } catch (erro) {
        // Actor fora do ar não pode derrubar a rodada.
        logger.warn('falha ao chamar a Apify', { rede, handle, actor, erro });
        return [];
      }

      if (!Array.isArray(registros)) {
        logger.warn('dataset não veio como lista', { rede, handle, actor });
        return [];
      }

      const posts = registros
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => normalizarRegistro(r, rede, handle))
        .filter((post): post is PostSocial => post !== null)
        .slice(0, limite);

      logger.debug('posts coletados', { rede, handle, actor, posts: posts.length });
      return posts;
    },
  };
}

export const apifyProvider = criarApifyProvider();
