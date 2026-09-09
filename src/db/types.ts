/** Tipos das tabelas do schema `radar`. Espelham migrations/0001_schema_radar.sql. */

export type TipoFonte = 'rss' | 'instagram' | 'tiktok';

export type StatusDelivery = 'pendente' | 'enviado' | 'falho' | 'descartado';

/** 1 = gravaria · 2 = talvez · 3 = lixo */
export type Feedback = 1 | 2 | 3;

export interface Creator {
  id: string;
  nome: string;
  whatsapp: string;
  nicho: string | null;
  perfil_texto: string;
  corte_score: number;
  /** 0 = ilimitado */
  teto_dia: number;
  /** `HH:MM:SS` */
  janela_silencio_inicio: string | null;
  janela_silencio_fim: string | null;
  ativo: boolean;
  created_at: string;
}

export interface Source {
  id: string;
  tipo: TipoFonte;
  /** URL do feed (rss) ou handle sem arroba (instagram, tiktok) */
  identificador: string;
  nome: string;
  ativo: boolean;
  ultima_coleta: string | null;
  created_at: string;
}

export interface CreatorSource {
  creator_id: string;
  source_id: string;
  created_at: string;
}

export interface Item {
  id: string;
  source_id: string;
  url: string;
  url_hash: string;
  titulo: string;
  texto: string | null;
  autor: string | null;
  publicado_em: string | null;
  coletado_em: string;
  entregavel: boolean;
}

/** O que o `collect` insere — o banco preenche id e coletado_em. */
export type ItemNovo = Omit<Item, 'id' | 'coletado_em'>;

export interface Delivery {
  id: string;
  creator_id: string;
  item_id: string;
  score: number | null;
  motivo_score: string | null;
  resumo: string | null;
  gancho: string | null;
  status: StatusDelivery;
  erro: string | null;
  tentativas: number;
  message_id: string | null;
  enviado_em: string | null;
  feedback: Feedback | null;
  feedback_em: string | null;
  created_at: string;
}

/** Delivery pendente já carregado com o item e a fonte — o que o `dispatch` usa. */
export interface DeliveryParaEnvio {
  delivery: Delivery;
  item: Item;
  creator: Creator;
  nomeFonte: string;
}
