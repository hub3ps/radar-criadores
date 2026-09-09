/**
 * Ambiente fixo para os testes unitários.
 *
 * Atribui SEM condição, de propósito: o teste precisa valer o mesmo com ou sem
 * `.env` na máquina. Se usasse `??=`, este arquivo rodaria antes do dotenv
 * (módulos ESM avaliam na ordem dos imports), fixaria valores falsos, e o
 * dotenv depois não sobrescreveria — que foi exatamente o bug que apontou
 * os scripts de dev para um host inexistente.
 *
 * Por isso: SÓ para teste unitário. Script de dev que fala com serviço real
 * (`rss-check.ts`, `preview.ts`) não importa este arquivo — usa o `.env` de verdade.
 */
const FIXOS: Record<string, string> = {
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste',
  SUPABASE_SCHEMA: 'radar',
  OPENROUTER_API_KEY: 'chave-de-teste',
  EVOLUTION_BASE_URL: 'https://evolution.teste',
  EVOLUTION_INSTANCE: 'teste',
  EVOLUTION_API_KEY: 'chave-de-teste',
  EVOLUTION_WEBHOOK_TOKEN: 'token-de-teste-longo',
  LOG_LEVEL: 'error',
  TZ: 'America/Sao_Paulo',
};

for (const [chave, valor] of Object.entries(FIXOS)) {
  process.env[chave] = valor;
}
