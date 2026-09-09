import { criarColetorSocial } from './social/base.js';
import { apifyProvider } from './social/apify.js';
import type { Collector } from './types.js';

/**
 * TikTok via `SocialProvider`. O actor vem de `APIFY_ACTOR_TIKTOK`
 * (padrão `scraptik/tiktok-api`, ~US$ 0,002 por requisição, independente do
 * número de resultados — cobrança previsível). Trocar de fornecedor é trocar o
 * provider aqui.
 */
export const tiktokCollector: Collector = criarColetorSocial('tiktok', apifyProvider);
