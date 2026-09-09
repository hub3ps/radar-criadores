import { config } from '../config.js';
import { log } from '../logger.js';

const logger = log.com({ canal: 'whatsapp' });

const TIMEOUT_MS = 20_000;

export interface ResultadoEnvio {
  /** `key.id` devolvido pela Evolution. É o que liga a resposta 1/2/3 de volta ao delivery. */
  messageId: string | null;
}

export class ErroEnvio extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ErroEnvio';
  }
}

/** Extrai `key.id` da resposta da Evolution sem confiar no formato exato. */
function extrairMessageId(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null;

  const chave = (corpo as { key?: unknown }).key;
  if (typeof chave === 'object' && chave !== null) {
    const id = (chave as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }

  const direto = (corpo as { messageId?: unknown }).messageId;
  return typeof direto === 'string' && direto !== '' ? direto : null;
}

/**
 * Envia texto via Evolution API v2.
 * `POST /message/sendText/{instance}` com `{ number, text }` e a chave no header `apikey`.
 */
export async function enviarTexto(numero: string, texto: string): Promise<ResultadoEnvio> {
  const url = `${config.evolution.baseUrl}/message/sendText/${encodeURIComponent(config.evolution.instancia)}`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        apikey: config.evolution.apiKey,
      },
      body: JSON.stringify({ number: numero, text: texto }),
    });
  } catch (erro) {
    throw new ErroEnvio(
      `Evolution inacessível: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }

  const bruto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroEnvio(`Evolution devolveu ${resposta.status}: ${bruto.slice(0, 300)}`, resposta.status);
  }

  let corpo: unknown = null;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    // Envio deu 2xx; corpo não-JSON só significa que ficamos sem o message_id.
    logger.warn('resposta de envio não era JSON', { corpo: bruto.slice(0, 200) });
  }

  const messageId = extrairMessageId(corpo);
  if (!messageId) {
    // Sem message_id o feedback ainda funciona pelo fallback de "última enviada".
    logger.warn('envio sem message_id — feedback vai depender do fallback por número');
  }

  return { messageId };
}
