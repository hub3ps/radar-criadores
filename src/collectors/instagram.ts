import { criarColetorSocial } from './social/base.js';
import { apifyProvider } from './social/apify.js';
import type { Collector } from './types.js';

/**
 * Instagram via `SocialProvider`. O actor vem de `APIFY_ACTOR_INSTAGRAM`
 * (padrão `apify/instagram-scraper`, ~US$ 1,50 por 1.000 posts, cobrança por
 * resultado). Trocar de fornecedor é trocar o provider aqui.
 */
export const instagramCollector: Collector = criarColetorSocial('instagram', apifyProvider);
