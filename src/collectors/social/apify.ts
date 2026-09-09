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
  const url = campo(registro, 'url', 'postUrl', 'webVideoUrl', 'shareUrl', 'share_url', 'share_info.share_url', 'link');
  if (!url) return null;

  const legenda = campo(registro, 'caption', 'text', 'desc', 'description', 'title');

  // O TikTok devolve o link com rastreadores de compartilhamento; a URL canônica
  // é estável e é o que o dedupe precisa.
  const limpa = url.split('?')[0] ?? url;

  return {
    url: limpa,
    titulo: tituloDaLegenda(legenda, handle, rede),
    texto: legenda,
    autor: `@${campo(registro, 'ownerUsername', 'authorMeta.name', 'author.unique_id', 'author.uniqueId', 'uniqueId') ?? handle}`,
    publicado_em: paraIso(
      campo(registro, 'timestamp', 'createTimeISO', 'createTime', 'create_time', 'publishedAt', 'takenAt'),
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

  // O scraptik/tiktok-api é uma API por endpoint: você preenche os campos do
  // endpoint que quer usar. Posts de um perfil exigem o userId numérico, então
  // são duas chamadas — `usernameToId` e depois `userPosts`.
  return { usernameToId_username: handle };
}

/** Segundo passo do TikTok: os posts, já com o userId resolvido. */
function inputPostsTiktok(userId: string, limite: number): Record<string, unknown> {
  // Cobra por requisição, não por resultado: puxar 3 ou 30 custa o mesmo.
  // O limite existe para não inundar o WhatsApp, não para economizar.
  return { userPosts_userId: userId, userPosts_count: limite };
}

/** O userPosts devolve um único registro embrulhando a lista em `aweme_list`. */
function desembrulhar(registros: Record<string, unknown>[]): Record<string, unknown>[] {
  const saida: Record<string, unknown>[] = [];

  for (const registro of registros) {
    const lista = registro['aweme_list'] ?? registro['itemList'] ?? registro['data'];
    if (Array.isArray(lista)) {
      for (const item of lista) {
        if (typeof item === 'object' && item !== null) saida.push(item as Record<string, unknown>);
      }
    } else {
      saida.push(registro);
    }
  }

  return saida;
}

/**
 * Roda um actor e devolve o dataset. `null` quando falhou — actor fora do ar
 * não pode derrubar a rodada das outras fontes.
 */
async function chamarActor(
  actor: string,
  input: Record<string, unknown>,
  ctx: { rede: string; handle: string },
): Promise<Record<string, unknown>[] | null> {
  const url = `${API}/acts/${idDoActor(actor)}/run-sync-get-dataset-items`;

  let dados: unknown;
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
        ...ctx,
        actor,
        status: resposta.status,
        corpo: (await resposta.text()).slice(0, 500),
      });
      return null;
    }

    dados = await resposta.json();
  } catch (erro) {
    logger.warn('falha ao chamar a Apify', { ...ctx, actor, erro });
    return null;
  }

  if (!Array.isArray(dados)) {
    logger.warn('dataset não veio como lista', { ...ctx, actor });
    return null;
  }

  return dados.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
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

      const registros = await chamarActor(actor, input, { rede, handle });
      if (registros === null) return [];

      let brutos = registros.filter(
        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
      );

      // TikTok: o primeiro passo só resolve o userId. Os posts vêm na segunda
      // chamada, e vêm embrulhados numa lista dentro de um único registro.
      if (rede === 'tiktok') {
        const userId = brutos
          .map((r) => campo(r, 'uid', 'user_id', 'userId', 'id'))
          .find((id): id is string => id !== null && /^\d{5,}$/.test(id));

        if (!userId) {
          logger.warn('não resolvi o userId do TikTok', { handle, actor });
          return [];
        }

        const segunda = await chamarActor(actor, inputPostsTiktok(userId, limite), { rede, handle });
        if (segunda === null) return [];
        brutos = desembrulhar(segunda);
      }

      const posts = brutos
        .map((r) => normalizarRegistro(r, rede, handle))
        .filter((post): post is PostSocial => post !== null)
        .slice(0, limite);

      logger.debug('posts coletados', { rede, handle, actor, posts: posts.length });
      return posts;
    },
  };
}

export const apifyProvider = criarApifyProvider();
