import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import { variantesWhatsapp } from '../core/formatter.js';
import type { Delivery, Feedback } from '../db/types.js';

const logger = log.com({ canal: 'inbound' });

/**
 * Fallback: sem `stanzaId`, a resposta é atribuída à última mensagem enviada
 * para aquele número dentro desta janela. Na prática ela responde logo depois
 * de receber; mais que isso não dá para presumir a qual item ela se referia.
 */
const JANELA_FALLBACK_HORAS = 6;

export interface ResultadoInbound {
  /** `ignorado` cobre tudo que não é 1/2/3: conversa normal, eco da própria mensagem, etc. */
  status: 'gravado' | 'ignorado' | 'sem-vinculo';
  deliveryId?: string;
  motivo?: string;
}

/** `5511999999999@s.whatsapp.net` → `5511999999999` */
function numeroDoJid(jid: string): string {
  return (jid.split('@')[0] ?? '').split(':')[0] ?? '';
}

function comoRegistro(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : null;
}

function comoTexto(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

export interface MensagemRecebida {
  /** Número de quem escreveu, só dígitos. */
  de: string;
  /** Texto puro da mensagem. */
  texto: string;
  /** true quando é eco de mensagem que nós mesmos enviamos. */
  minha: boolean;
  /** id da mensagem que está sendo respondida, quando é uma resposta. */
  respondendoA: string | null;
}

/**
 * Lê o payload do webhook da Evolution (evento `messages.upsert`).
 * O texto pode vir em `conversation` (mensagem simples) ou em
 * `extendedTextMessage.text` (resposta a outra mensagem) — e é só nesse segundo
 * caso que existe o `stanzaId` com o id da mensagem respondida.
 */
export function extrairMensagem(payload: unknown): MensagemRecebida | null {
  const corpo = comoRegistro(payload);
  if (!corpo) return null;

  // A Evolution manda `MESSAGES_UPSERT` em algumas versões e `messages.upsert`
  // em outras. Comparar a forma crua descartava o payload em silêncio.
  const evento = comoTexto(corpo.event);
  if (evento !== null) {
    const normalizado = evento.toLowerCase().replace(/_/g, '.');
    if (!normalizado.startsWith('messages.upsert')) return null;
  }

  // A Evolution manda `data` como objeto; em alguns modos, como lista.
  const bruto = Array.isArray(corpo.data) ? corpo.data[0] : corpo.data;
  const dados = comoRegistro(bruto) ?? corpo;

  const chave = comoRegistro(dados.key);
  if (!chave) return null;

  const jid = comoTexto(chave.remoteJid);
  if (!jid) return null;

  const mensagem = comoRegistro(dados.message);
  const estendida = comoRegistro(mensagem?.extendedTextMessage);
  const contexto = comoRegistro(estendida?.contextInfo);

  const texto = comoTexto(mensagem?.conversation) ?? comoTexto(estendida?.text);
  if (texto === null) return null;

  return {
    de: numeroDoJid(jid),
    texto: texto.trim(),
    minha: chave.fromMe === true,
    respondendoA: comoTexto(contexto?.stanzaId),
  };
}

/** `"1"`, `" 2 "`, `"3."` → 1 | 2 | 3. Qualquer outra coisa → null. */
export function lerFeedback(texto: string): Feedback | null {
  const limpo = texto.trim().replace(/[.!)\s]+$/, '');
  if (limpo === '1') return 1;
  if (limpo === '2') return 2;
  if (limpo === '3') return 3;
  return null;
}

/** Acha o delivery pelo id da mensagem respondida. */
async function porMessageId(messageId: string): Promise<Delivery | null> {
  const { data, error } = await db
    .from('deliveries')
    .select('*')
    .eq('message_id', messageId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`busca de delivery por message_id: ${error.message}`);
  return (data as Delivery | null) ?? null;
}

/** Fallback: última mensagem enviada para aquele número, dentro da janela. */
async function ultimaEnviadaPara(numero: string): Promise<Delivery | null> {
  const { data: creators, error: erroCreator } = await db
    .from('creators')
    .select('id, whatsapp');

  if (erroCreator) throw new Error(`busca de criadoras: ${erroCreator.message}`);

  const doRecebido = new Set(variantesWhatsapp(numero));
  const creator = (creators ?? []).find((c: { whatsapp: string }) =>
    variantesWhatsapp(c.whatsapp).some((v) => doRecebido.has(v)),
  ) as { id: string } | undefined;

  if (!creator) return null;

  const desde = new Date(Date.now() - JANELA_FALLBACK_HORAS * 3_600_000).toISOString();

  const { data, error } = await db
    .from('deliveries')
    .select('*')
    .eq('creator_id', creator.id)
    .eq('status', 'enviado')
    .is('feedback', null)
    .gte('enviado_em', desde)
    .order('enviado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`busca da última enviada: ${error.message}`);
  return (data as Delivery | null) ?? null;
}

/**
 * Processa uma mensagem recebida e grava o feedback quando for 1, 2 ou 3.
 * Idempotente: reenvio do mesmo webhook não sobrescreve um feedback já dado.
 */
export async function processarInbound(payload: unknown): Promise<ResultadoInbound> {
  const mensagem = extrairMensagem(payload);

  if (!mensagem) {
    // Sem isto, um payload em formato inesperado sumia sem deixar rastro no log.
    const corpo = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
    logger.warn('webhook não reconhecido como mensagem de texto', {
      evento: corpo.event ?? '(sem campo event)',
      chaves: Object.keys(corpo),
    });
    return { status: 'ignorado', motivo: 'payload sem mensagem de texto' };
  }
  if (mensagem.minha) return { status: 'ignorado', motivo: 'eco de mensagem própria' };

  const feedback = lerFeedback(mensagem.texto);
  if (feedback === null) {
    logger.debug('mensagem não é 1/2/3', { de: mensagem.de, texto: mensagem.texto.slice(0, 60) });
    return { status: 'ignorado', motivo: 'texto não é 1, 2 ou 3' };
  }

  const delivery = mensagem.respondendoA
    ? ((await porMessageId(mensagem.respondendoA)) ?? (await ultimaEnviadaPara(mensagem.de)))
    : await ultimaEnviadaPara(mensagem.de);

  if (!delivery) {
    logger.warn('feedback sem delivery correspondente', {
      de: mensagem.de,
      feedback,
      respondendoA: mensagem.respondendoA,
    });
    return { status: 'sem-vinculo', motivo: 'nenhum delivery bate com a resposta' };
  }

  if (delivery.feedback !== null) {
    return { status: 'ignorado', deliveryId: delivery.id, motivo: 'feedback já registrado' };
  }

  const { error } = await db
    .from('deliveries')
    .update({ feedback, feedback_em: new Date().toISOString() })
    .eq('id', delivery.id)
    .is('feedback', null);

  if (error) throw new Error(`gravação de feedback: ${error.message}`);

  logger.info('feedback gravado', { deliveryId: delivery.id, feedback, de: mensagem.de });
  return { status: 'gravado', deliveryId: delivery.id };
}

/** Compara o token do webhook em tempo constante. */
export function tokenValido(recebido: string | undefined | null): boolean {
  const esperado = config.evolution.webhookToken;
  if (!recebido || recebido.length !== esperado.length) return false;

  let diferenca = 0;
  for (let i = 0; i < esperado.length; i += 1) {
    diferenca |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  }
  return diferenca === 0;
}

