import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Cliente único, com a service_role key. O processo é backend: escreve em todas
 * as tabelas e ignora RLS.
 *
 * O schema `radar` precisa estar na lista de "Exposed schemas" do projeto
 * (Settings → API), senão o PostgREST devolve 404 em toda query.
 */
export const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  db: { schema: config.supabase.schema },
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Lança se a query falhou; devolve os dados já tipados se deu certo. */
export function ouLancar<T>(
  resultado: { data: T | null; error: { message: string; code?: string } | null },
  contexto: string,
): T {
  if (resultado.error) {
    throw new Error(`${contexto}: ${resultado.error.message}`);
  }
  if (resultado.data === null) {
    throw new Error(`${contexto}: resposta vazia`);
  }
  return resultado.data;
}
