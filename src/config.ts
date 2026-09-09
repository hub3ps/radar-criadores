import 'dotenv/config';
import { z } from 'zod';

/** `"true"` / `"1"` viram true; qualquer outra coisa vira false. */
const booleano = (padrao: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? padrao : v === 'true' || v === '1'));

const inteiro = (padrao: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? padrao : Number(v)))
    .pipe(z.number().int().min(min));

const Env = z.object({
  // --- Supabase ---
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_SCHEMA: z.string().default('radar'),

  // --- OpenRouter (scorer) ---
  // A API do OpenRouter é compatível com a da OpenAI, não com a da Anthropic:
  // o modelo vai no formato `fornecedor/modelo`.
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-opus-5'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  // `none` não manda o parâmetro de raciocínio — mais barato e menos coisa
  // para o roteamento recusar. Suba se as notas vierem rasas.
  OPENROUTER_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).default('none'),

  // --- Evolution API (v2) ---
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_INSTANCE: z.string().min(1),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_WEBHOOK_TOKEN: z.string().min(8),

  // --- Apify (Instagram e TikTok) ---
  APIFY_TOKEN: z.string().optional(),
  APIFY_ACTOR_INSTAGRAM: z.string().default('apify/instagram-scraper'),
  APIFY_ACTOR_TIKTOK: z.string().default('scraptik/tiktok-api'),
  SOCIAL_DRY_RUN: booleano(true),

  // --- Cadência ---
  RSS_INTERVALO_MIN: inteiro(5),
  SOCIAL_INTERVALO_MIN: inteiro(60),
  SOCIAL_POSTS_POR_PERFIL: inteiro(3),
  DISPATCH_INTERVALO_MIN: inteiro(2),

  // --- Controles de ruído (fase de calibragem: todos desligados) ---
  FILTRO_SCORE_ATIVO: booleano(false),
  TETO_DIARIO_ATIVO: booleano(false),
  JANELA_SILENCIO_ATIVA: booleano(false),
  COOLDOWN_TEMA_ATIVO: booleano(false),
  COOLDOWN_TEMA_HORAS: inteiro(12),

  // --- Runtime ---
  PORT: inteiro(3000),
  TZ: z.string().default('America/Sao_Paulo'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BACKFILL_PRIMEIRA_COLETA: booleano(false),

  // Quantos itens o `process` avalia por rodada. Segura o gasto com o scorer
  // se uma fonte despejar um lote grande de uma vez.
  PROCESS_LOTE_MAX: inteiro(25),
  // Quantas mensagens o `dispatch` manda por rodada.
  DISPATCH_LOTE_MAX: inteiro(10),
  // Itens mais velhos que isso não viram delivery — novidade velha não é novidade.
  ITEM_VALIDADE_HORAS: inteiro(48),
  // Buscar o corpo do artigo na URL quando o feed só entrega um resumo curto.
  RSS_BUSCAR_CORPO: booleano(true),
});

function carregar() {
  const resultado = Env.safeParse(process.env);

  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Sem logger aqui: o config falha antes de qualquer coisa existir.
    console.error(`Configuração inválida no .env:\n${problemas}`);
    process.exit(1);
  }

  const e = resultado.data;

  return Object.freeze({
    supabase: {
      url: e.SUPABASE_URL,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      schema: e.SUPABASE_SCHEMA,
    },
    openrouter: {
      apiKey: e.OPENROUTER_API_KEY,
      modelo: e.OPENROUTER_MODEL,
      baseUrl: e.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
      reasoningEffort: e.OPENROUTER_REASONING_EFFORT,
    },
    evolution: {
      baseUrl: e.EVOLUTION_BASE_URL.replace(/\/+$/, ''),
      instancia: e.EVOLUTION_INSTANCE,
      apiKey: e.EVOLUTION_API_KEY,
      webhookToken: e.EVOLUTION_WEBHOOK_TOKEN,
    },
    apify: {
      token: e.APIFY_TOKEN ?? '',
      actorInstagram: e.APIFY_ACTOR_INSTAGRAM,
      actorTiktok: e.APIFY_ACTOR_TIKTOK,
      dryRun: e.SOCIAL_DRY_RUN,
    },
    cadencia: {
      rssIntervaloMin: e.RSS_INTERVALO_MIN,
      socialIntervaloMin: e.SOCIAL_INTERVALO_MIN,
      socialPostsPorPerfil: e.SOCIAL_POSTS_POR_PERFIL,
      dispatchIntervaloMin: e.DISPATCH_INTERVALO_MIN,
    },
    regras: {
      filtroScoreAtivo: e.FILTRO_SCORE_ATIVO,
      tetoDiarioAtivo: e.TETO_DIARIO_ATIVO,
      janelaSilencioAtiva: e.JANELA_SILENCIO_ATIVA,
      cooldownTemaAtivo: e.COOLDOWN_TEMA_ATIVO,
      cooldownTemaHoras: e.COOLDOWN_TEMA_HORAS,
    },
    runtime: {
      port: e.PORT,
      tz: e.TZ,
      logLevel: e.LOG_LEVEL,
      backfillPrimeiraColeta: e.BACKFILL_PRIMEIRA_COLETA,
      processLoteMax: e.PROCESS_LOTE_MAX,
      dispatchLoteMax: e.DISPATCH_LOTE_MAX,
      itemValidadeHoras: e.ITEM_VALIDADE_HORAS,
      rssBuscarCorpo: e.RSS_BUSCAR_CORPO,
    },
  });
}

export const config = carregar();
export type Config = typeof config;
