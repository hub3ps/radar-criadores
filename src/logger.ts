import { config } from './config.js';

type Nivel = 'debug' | 'info' | 'warn' | 'error';

const PESO: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MINIMO = PESO[config.runtime.logLevel];

/** Erro vira objeto serializável; o resto passa direto. */
function normalizar(dados: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(dados)) {
    saida[chave] =
      valor instanceof Error
        ? { nome: valor.name, mensagem: valor.message, stack: valor.stack }
        : valor;
  }
  return saida;
}

function escrever(nivel: Nivel, mensagem: string, dados: Record<string, unknown> = {}): void {
  if (PESO[nivel] < MINIMO) return;

  const linha = JSON.stringify({
    ts: new Date().toISOString(),
    nivel,
    msg: mensagem,
    ...normalizar(dados),
  });

  // Um JSON por linha, tudo em stdout — é o que o Easypanel coleta.
  process.stdout.write(`${linha}\n`);
}

export const log = {
  debug: (msg: string, dados?: Record<string, unknown>) => escrever('debug', msg, dados),
  info: (msg: string, dados?: Record<string, unknown>) => escrever('info', msg, dados),
  warn: (msg: string, dados?: Record<string, unknown>) => escrever('warn', msg, dados),
  error: (msg: string, dados?: Record<string, unknown>) => escrever('error', msg, dados),
  /** Logger com campos fixos — ex.: `log.com({ job: 'collect' })`. */
  com(fixos: Record<string, unknown>) {
    return {
      debug: (msg: string, d?: Record<string, unknown>) => escrever('debug', msg, { ...fixos, ...d }),
      info: (msg: string, d?: Record<string, unknown>) => escrever('info', msg, { ...fixos, ...d }),
      warn: (msg: string, d?: Record<string, unknown>) => escrever('warn', msg, { ...fixos, ...d }),
      error: (msg: string, d?: Record<string, unknown>) => escrever('error', msg, { ...fixos, ...d }),
    };
  },
};

export type Logger = ReturnType<typeof log.com>;
