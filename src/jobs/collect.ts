import { coletores, TIPOS_SOCIAIS } from '../collectors/index.js';
import { dedupePorHash, slugDaUrl } from '../core/dedupe.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import type { ItemNovo, Source, TipoFonte } from '../db/types.js';

const logger = log.com({ job: 'collect' });

/** Quantos itens pedir por fonte. RSS costuma trazer 10-20 por página. */
const LIMITE_RSS = 20;

export interface ResumoColeta {
  fontes: number;
  coletados: number;
  novos: number;
  backfill: number;
}

async function fontesAtivas(tipos: TipoFonte[]): Promise<Source[]> {
  const { data, error } = await db
    .from('sources')
    .select('*')
    .eq('ativo', true)
    .in('tipo', tipos);

  if (error) throw new Error(`busca de fontes: ${error.message}`);
  return (data ?? []) as Source[];
}

/** Quais desses hashes já estão no banco. */
async function hashesConhecidos(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();

  const { data, error } = await db.from('items').select('url_hash').in('url_hash', hashes);
  if (error) throw new Error(`consulta de dedupe: ${error.message}`);

  return new Set((data ?? []).map((linha: { url_hash: string }) => linha.url_hash));
}

/** Por quanto tempo um slug já visto continua bloqueando uma republicação. */
const JANELA_SLUG_HORAS = 72;

/**
 * Slugs que esta fonte já publicou recentemente.
 *
 * O `url_hash` não pega a mesma matéria republicada sob outra categoria —
 * `/cultura-pop/x/` e `/series/x/`. Aconteceu de verdade: a criadora recebeu o
 * mesmo item duas vezes, com 5 minutos de diferença, e pagamos o scorer duas
 * vezes. A janela evita carregar o histórico inteiro da fonte a cada coleta.
 */
async function slugsRecentes(sourceId: string): Promise<Set<string>> {
  const desde = new Date(Date.now() - JANELA_SLUG_HORAS * 3_600_000).toISOString();

  const { data, error } = await db
    .from('items')
    .select('url')
    .eq('source_id', sourceId)
    .gte('coletado_em', desde);

  if (error) throw new Error(`consulta de slugs: ${error.message}`);

  const slugs = new Set<string>();
  for (const linha of (data ?? []) as { url: string }[]) {
    const slug = slugDaUrl(linha.url);
    if (slug !== null) slugs.add(slug);
  }
  return slugs;
}

/**
 * Coleta uma fonte e grava o que for inédito.
 *
 * Na primeira coleta de uma fonte nova o feed traz o histórico inteiro. Esses
 * itens entram com `entregavel = false`: ficam gravados para o dedupe funcionar,
 * mas não viram delivery — senão o primeiro boot despeja 40 mensagens de uma vez.
 * `BACKFILL_PRIMEIRA_COLETA=true` desliga esse comportamento.
 */
async function coletarFonte(fonte: Source, limite: number): Promise<{ coletados: number; novos: number; backfill: boolean }> {
  const coletor = coletores[fonte.tipo];
  const brutos = await coletor.coletar(fonte, { limite });

  const ehBackfill = fonte.ultima_coleta === null && !config.runtime.backfillPrimeiraColeta;

  // `ultima_coleta` marca a fonte como já visitada mesmo quando nada veio —
  // senão uma fonte que falha para sempre ficaria eternamente em "primeira coleta".
  const marcarVisitada = db
    .from('sources')
    .update({ ultima_coleta: new Date().toISOString() })
    .eq('id', fonte.id);

  if (brutos.length === 0) {
    await marcarVisitada;
    return { coletados: 0, novos: 0, backfill: ehBackfill };
  }

  const comHash = dedupePorHash(brutos);
  const [jaConhecidos, jaPublicados] = await Promise.all([
    hashesConhecidos(comHash.map((i) => i.url_hash)),
    slugsRecentes(fonte.id),
  ]);

  const novos: ItemNovo[] = comHash
    .filter((item) => {
      if (jaConhecidos.has(item.url_hash)) return false;

      // Mesma matéria sob outra categoria: URL diferente, conteúdo igual.
      const slug = slugDaUrl(item.url);
      if (slug !== null && jaPublicados.has(slug)) {
        logger.debug('slug repetido em outro caminho', { fonte: fonte.nome, url: item.url });
        return false;
      }
      return true;
    })
    .map((item) => ({
      source_id: fonte.id,
      url: item.url,
      url_hash: item.url_hash,
      titulo: item.titulo,
      texto: item.texto,
      autor: item.autor,
      publicado_em: item.publicado_em,
      entregavel: !ehBackfill,
    }));

  if (novos.length > 0) {
    // `ignoreDuplicates` cobre a corrida entre a consulta de dedupe e o insert:
    // duas fontes podem publicar a mesma URL na mesma rodada.
    const { error } = await db
      .from('items')
      .upsert(novos, { onConflict: 'url_hash', ignoreDuplicates: true });

    if (error) throw new Error(`insert de itens (${fonte.nome}): ${error.message}`);
  }

  await marcarVisitada;

  return { coletados: brutos.length, novos: novos.length, backfill: ehBackfill };
}

/**
 * Roda a coleta para os tipos de fonte informados.
 * RSS e social têm cadências diferentes, por isso a separação.
 */
export async function collect(tipos: TipoFonte[]): Promise<ResumoColeta> {
  const fontes = await fontesAtivas(tipos);
  const resumo: ResumoColeta = { fontes: fontes.length, coletados: 0, novos: 0, backfill: 0 };

  if (fontes.length === 0) {
    logger.debug('nenhuma fonte ativa', { tipos });
    return resumo;
  }

  const limite = tipos.every((t) => TIPOS_SOCIAIS.includes(t))
    ? config.cadencia.socialPostsPorPerfil
    : LIMITE_RSS;

  // Sequencial de propósito: 5 a 10 fontes não justificam paralelismo, e assim
  // uma rodada não abre dez conexões de scraping ao mesmo tempo.
  for (const fonte of fontes) {
    try {
      const parcial = await coletarFonte(fonte, limite);
      resumo.coletados += parcial.coletados;
      resumo.novos += parcial.novos;
      if (parcial.backfill) resumo.backfill += parcial.novos;

      logger.debug('fonte coletada', {
        fonte: fonte.nome,
        tipo: fonte.tipo,
        coletados: parcial.coletados,
        novos: parcial.novos,
        backfill: parcial.backfill,
      });
    } catch (erro) {
      // Uma fonte quebrada não pode derrubar a rodada das outras.
      logger.error('falha ao coletar fonte', { fonte: fonte.nome, tipo: fonte.tipo, erro });
    }
  }

  logger.info('coleta concluída', { tipos, ...resumo });
  return resumo;
}

export const collectRss = () => collect(['rss']);
export const collectSocial = () => collect(TIPOS_SOCIAIS);
