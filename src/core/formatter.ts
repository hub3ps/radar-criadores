import type { Creator, Delivery, Item } from '../db/types.js';

/**
 * "há {tempo}" no formato curto que cabe na mensagem: `agora`, `12 min`, `3 h`, `2 d`.
 * Datas no futuro (relógio da fonte adiantado) viram `agora`.
 */
export function tempoRelativo(quando: Date, agora: Date = new Date()): string {
  const segundos = Math.floor((agora.getTime() - quando.getTime()) / 1000);

  if (segundos < 60) return 'agora';

  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h`;

  const dias = Math.floor(horas / 24);
  return `${dias} d`;
}

export interface EntradaMensagem {
  delivery: Pick<Delivery, 'score' | 'resumo' | 'gancho'>;
  item: Pick<Item, 'titulo' | 'url' | 'publicado_em' | 'coletado_em'>;
  nomeFonte: string;
}

/**
 * Monta a mensagem do WhatsApp.
 *
 * Sem o título da matéria e sem a nota, por pedido da primeira criadora usando
 * o produto de verdade: o título é manchete escrita para outro público e só
 * atrapalha a leitura do resumo, e a nota não serve para nada na mão dela —
 * ela existe para filtrar antes do envio, não para ser lida.
 *
 * A última linha é o que ensina a responder 1/2/3, e é dela que sai todo o
 * feedback da calibragem.
 */
export function formatarMensagem(entrada: EntradaMensagem, agora: Date = new Date()): string {
  const { delivery, item, nomeFonte } = entrada;

  // Publicação é o que interessa; se o feed não informou, o momento da coleta serve.
  const referencia = new Date(item.publicado_em ?? item.coletado_em);
  const quando = Number.isNaN(referencia.getTime()) ? agora : referencia;

  const resumo = (delivery.resumo ?? '').trim();
  const gancho = (delivery.gancho ?? '').trim();

  const linhas = [
    `${nomeFonte} · há ${tempoRelativo(quando, agora)}`,
    '',
    resumo,
    '',
    `Gancho: ${gancho}`,
    '',
    item.url,
    '',
    'Responde: 1 = vou gravar · 2 = talvez · 3 = lixo',
  ];

  return linhas.join('\n');
}

/** Número no formato que a Evolution espera: só dígitos. */
export function normalizarWhatsapp(numero: Creator['whatsapp']): string {
  return numero.replace(/\D/g, '');
}

/**
 * Formas equivalentes do mesmo celular brasileiro.
 *
 * Desde 2016 o celular tem nove dígitos, mas o WhatsApp ainda entrega o JID sem
 * o nono em números antigos — e às vezes com. Comparar string exata faz o
 * feedback de `5547996489767` não casar com `554796489767`, que é a mesma pessoa.
 */
export function variantesWhatsapp(numero: string): string[] {
  const so = normalizarWhatsapp(numero);
  const variantes = new Set([so]);

  const comNono = /^55(\d{2})9(\d{8})$/.exec(so);
  if (comNono) variantes.add(`55${comNono[1]}${comNono[2]}`);

  const semNono = /^55(\d{2})(\d{8})$/.exec(so);
  if (semNono) variantes.add(`55${semNono[1]}9${semNono[2]}`);

  return [...variantes];
}
