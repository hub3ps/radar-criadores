import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { processarInbound, tokenValido } from './delivery/inbound.js';
import { config } from './config.js';
import { log } from './logger.js';

const logger = log.com({ componente: 'http' });

/** Webhook maior que isso não é mensagem de WhatsApp — é abuso. */
const CORPO_MAX_BYTES = 1_000_000;

function responder(res: ServerResponse, status: number, corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
  });
  res.end(texto);
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const pedacos: Buffer[] = [];
  let tamanho = 0;

  for await (const pedaco of req) {
    const buffer = pedaco as Buffer;
    tamanho += buffer.length;
    if (tamanho > CORPO_MAX_BYTES) throw new Error('corpo grande demais');
    pedacos.push(buffer);
  }

  if (pedacos.length === 0) return null;
  return JSON.parse(Buffer.concat(pedacos).toString('utf8'));
}

/**
 * O token pode vir no caminho (`/webhook/evolution/<token>`) ou no header
 * `x-webhook-token`. A Evolution não manda header customizado por padrão, então
 * na prática usa-se o caminho.
 */
function tokenDaRequisicao(caminho: string, req: IncomingMessage): string | null {
  const doCaminho = caminho.replace(/^\/webhook\/evolution\/?/, '');
  if (doCaminho !== '') return decodeURIComponent(doCaminho);

  const header = req.headers['x-webhook-token'];
  return typeof header === 'string' ? header : null;
}

async function rotear(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caminho = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

  // Healthcheck do Easypanel.
  if (req.method === 'GET' && caminho === '/health') {
    return responder(res, 200, { status: 'ok', ts: new Date().toISOString() });
  }

  if (req.method === 'POST' && caminho.startsWith('/webhook/evolution')) {
    if (!tokenValido(tokenDaRequisicao(caminho, req))) {
      logger.warn('webhook com token inválido');
      return responder(res, 401, { erro: 'token inválido' });
    }

    let payload: unknown;
    try {
      payload = await lerCorpo(req);
    } catch (erro) {
      logger.warn('corpo do webhook ilegível', { erro });
      return responder(res, 400, { erro: 'corpo inválido' });
    }

    try {
      const resultado = await processarInbound(payload);
      return responder(res, 200, resultado);
    } catch (erro) {
      // 200 de propósito: a Evolution reenfileira em erro, e reenviar não conserta
      // uma falha nossa de banco. O erro fica no log.
      logger.error('falha ao processar inbound', { erro });
      return responder(res, 200, { status: 'erro-interno' });
    }
  }

  responder(res, 404, { erro: 'rota não encontrada' });
}

export function iniciarServidor(): Server {
  const servidor = createServer((req, res) => {
    void rotear(req, res).catch((erro: unknown) => {
      logger.error('erro não tratado na rota', { erro });
      if (!res.headersSent) responder(res, 500, { erro: 'erro interno' });
    });
  });

  servidor.listen(config.runtime.port, () => {
    logger.info('servidor no ar', {
      porta: config.runtime.port,
      rotas: ['GET /health', 'POST /webhook/evolution/:token'],
    });
  });

  return servidor;
}
