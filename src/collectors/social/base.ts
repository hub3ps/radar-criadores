import { config } from '../../config.js';
import { log } from '../../logger.js';
import type { Source } from '../../db/types.js';
import type { Collector, OpcoesColeta, RawItem } from '../types.js';
import type { SocialProvider } from './provider.js';

/** `@fulana`, `https://instagram.com/fulana/` ou `fulana` → `fulana`. */
export function extrairHandle(identificador: string): string {
  const texto = identificador.trim();

  if (texto.startsWith('http://') || texto.startsWith('https://')) {
    try {
      const caminho = new URL(texto).pathname.split('/').filter(Boolean);
      const primeiro = caminho[0] ?? '';
      return primeiro.replace(/^@/, '');
    } catch {
      /* cai no tratamento abaixo */
    }
  }

  return texto.replace(/^@/, '').replace(/\/+$/, '');
}

/**
 * Coletor social genérico. Instagram e TikTok só diferem no `tipo` e no actor
 * escolhido lá no provedor — a lógica é a mesma, então mora aqui.
 */
export function criarColetorSocial(
  tipo: Extract<Source['tipo'], 'instagram' | 'tiktok'>,
  provider: SocialProvider,
): Collector {
  const logger = log.com({ coletor: tipo, provedor: provider.nome });

  return {
    tipo,

    async coletar(fonte: Source, opcoes: OpcoesColeta): Promise<RawItem[]> {
      if (!config.apify.dryRun && !provider.disponivel()) {
        // Sem token: avisa e devolve vazio. Não derruba o processo.
        logger.warn('provedor indisponível — nada coletado', { fonte: fonte.nome });
        return [];
      }

      const handle = extrairHandle(fonte.identificador);
      if (handle === '') {
        logger.warn('identificador da fonte não resolve num handle', {
          fonte: fonte.nome,
          identificador: fonte.identificador,
        });
        return [];
      }

      // O teto vem do `.env` (`SOCIAL_POSTS_POR_PERFIL`): é decisão de custo.
      const limite = Math.min(opcoes.limite, config.cadencia.socialPostsPorPerfil);
      const posts = await provider.buscarPosts(tipo, handle, limite);

      return posts.map((post) => ({ ...post, source_id: fonte.id }));
    },
  };
}
