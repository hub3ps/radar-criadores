import { rssCollector } from './rss.js';
import { instagramCollector } from './instagram.js';
import { tiktokCollector } from './tiktok.js';
import type { TipoFonte } from '../db/types.js';
import type { Collector } from './types.js';

/** Registro de coletores por tipo de fonte. */
export const coletores: Record<TipoFonte, Collector> = {
  rss: rssCollector,
  instagram: instagramCollector,
  tiktok: tiktokCollector,
};

export const TIPOS_SOCIAIS: TipoFonte[] = ['instagram', 'tiktok'];
