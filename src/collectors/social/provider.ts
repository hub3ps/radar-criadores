import type { RawItem } from '../types.js';
import type { Source } from '../../db/types.js';

/**
 * Post normalizado como o provedor o entrega. Sem `source_id`: o provedor não
 * conhece o banco — quem amarra o post à fonte é o coletor.
 */
export type PostSocial = Omit<RawItem, 'source_id'>;

/**
 * Fornecedor de scraping de rede social.
 *
 * Actors da Apify são mantidos por terceiros e quebram quando a plataforma muda
 * o anti-bot. Trocar de fornecedor precisa custar um arquivo — por isso os
 * coletores de Instagram e TikTok só conhecem esta interface, e o nome do actor
 * vem do `.env`, nunca hardcoded.
 */
export interface SocialProvider {
  readonly nome: string;

  /** true quando há credencial configurada. Se false, o coletor loga aviso e devolve `[]`. */
  disponivel(): boolean;

  /**
   * Puxa até `limite` posts recentes de um perfil. `handle` vem sem o arroba.
   * Nunca lança: falha de rede ou de actor devolve `[]` e loga.
   */
  buscarPosts(rede: Source['tipo'], handle: string, limite: number): Promise<PostSocial[]>;
}
