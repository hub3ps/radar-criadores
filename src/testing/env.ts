/**
 * Preenche o `.env` mínimo para os testes.
 *
 * `config.ts` valida tudo no import e chama `process.exit(1)` se faltar variável.
 * Módulos ESM são avaliados na ordem em que aparecem os `import`, então basta
 * importar este arquivo ANTES do módulo sob teste. Não vai para o build
 * (`tsconfig.json` exclui `src/testing`).
 */
const PADROES: Record<string, string> = {
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste',
  OPENROUTER_API_KEY: 'chave-de-teste',
  EVOLUTION_BASE_URL: 'https://evolution.teste',
  EVOLUTION_INSTANCE: 'teste',
  EVOLUTION_API_KEY: 'chave-de-teste',
  EVOLUTION_WEBHOOK_TOKEN: 'token-de-teste-longo',
  LOG_LEVEL: 'error',
  TZ: 'America/Sao_Paulo',
};

for (const [chave, valor] of Object.entries(PADROES)) {
  process.env[chave] ??= valor;
}
