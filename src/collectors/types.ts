import type { Source } from '../db/types.js';

/**
 * Item normalizado, do jeito que sai de qualquer coletor.
 *
 * É esta forma que permite trocar o fornecedor de scraping de Instagram/TikTok
 * sem tocar em `dedupe`, `scorer`, `formatter` ou nos jobs: o resto do sistema
 * só conhece `RawItem`.
 */
export interface RawItem {
  url: string;
  titulo: string;
  texto: string | null;
  autor: string | null;
  /** ISO 8601. `null` quando a fonte não informa. */
  publicado_em: string | null;
  source_id: string;
}

export interface OpcoesColeta {
  /** Teto de itens trazidos por fonte, nesta rodada. */
  limite: number;
}

export interface Collector {
  /** Igual ao `sources.tipo` que este coletor atende. */
  readonly tipo: Source['tipo'];
  /**
   * Coleta os itens recentes de uma fonte.
   * Erros de rede/fornecedor devem ser tratados aqui: uma fonte quebrada não
   * pode derrubar a rodada das outras. Em caso de falha, devolva `[]`.
   */
  coletar(fonte: Source, opcoes: OpcoesColeta): Promise<RawItem[]>;
}
