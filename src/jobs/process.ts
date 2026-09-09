import { ErroScorer, pontuar } from '../core/scorer.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import type { Creator, Item } from '../db/types.js';

const logger = log.com({ job: 'process' });

export interface ResumoProcess {
  criadoras: number;
  avaliados: number;
  falhos: number;
}

async function criadorasAtivas(): Promise<Creator[]> {
  const { data, error } = await db.from('creators').select('*').eq('ativo', true);
  if (error) throw new Error(`busca de criadoras: ${error.message}`);
  return (data ?? []) as Creator[];
}

async function fontesDaCriadora(creatorId: string): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('creator_sources')
    .select('source_id, sources(id, nome)')
    .eq('creator_id', creatorId);

  if (error) throw new Error(`busca de fontes da criadora: ${error.message}`);

  const nomes = new Map<string, string>();
  // O join do PostgREST devolve `sources` como objeto ou como lista de um item,
  // dependendo de como ele infere a cardinalidade da FK.
  type Linha = { source_id: string; sources: { nome: string } | { nome: string }[] | null };

  for (const linha of (data ?? []) as unknown as Linha[]) {
    const fonte = Array.isArray(linha.sources) ? linha.sources[0] : linha.sources;
    nomes.set(linha.source_id, fonte?.nome ?? 'fonte desconhecida');
  }
  return nomes;
}

/**
 * Itens das fontes da criadora que ainda não viraram delivery para ela.
 *
 * Três filtros:
 * - `entregavel`, que exclui o backfill da primeira coleta de uma fonte
 * - validade: novidade de três dias atrás não é novidade, e pagar o scorer
 *   por ela é desperdício
 * - a data de cadastro dela. A proteção de backfill é por FONTE, não por
 *   criadora: sem este corte, quem se cadastra numa fonte que já está sendo
 *   coletada recebe o backlog inteiro de 48h no primeiro minuto.
 */
/**
 * O item foi publicado recentemente?
 *
 * Todos os outros filtros medem `coletado_em` — quando NÓS vimos o item. Se o
 * processo ficar fora do ar e voltar, ele coleta o feed inteiro naquele momento
 * e tudo parece novo, inclusive matéria de três dias atrás. Aqui olhamos a data
 * da fonte. Sem `publicado_em` (parte dos feeds e das redes não informa), a
 * coleta é o melhor palpite disponível.
 */
export function recemPublicado(item: Item): boolean {
  const quando = item.publicado_em ?? item.coletado_em;
  const data = new Date(quando).getTime();
  if (Number.isNaN(data)) return true;

  // Data no futuro é relógio adiantado da fonte, não motivo para descartar.
  const idadeHoras = (Date.now() - data) / 3_600_000;
  return idadeHoras <= config.runtime.itemIdadeMaxHoras;
}

async function itensPendentes(creator: Creator, sourceIds: string[], limite: number): Promise<Item[]> {
  if (sourceIds.length === 0) return [];

  const porValidade = Date.now() - config.runtime.itemValidadeHoras * 3_600_000;
  const desde = new Date(
    Math.max(porValidade, new Date(creator.created_at).getTime()),
  ).toISOString();

  const { data: itens, error } = await db
    .from('items')
    .select('*')
    .in('source_id', sourceIds)
    .eq('entregavel', true)
    .gte('coletado_em', desde)
    .order('coletado_em', { ascending: false })
    // Folga sobre o lote: parte destes já terá delivery e vai sair no filtro abaixo.
    .limit(limite * 5);

  if (error) throw new Error(`busca de itens: ${error.message}`);

  const candidatos = ((itens ?? []) as Item[]).filter(recemPublicado);
  if (candidatos.length === 0) return [];

  const { data: existentes, error: erroDeliveries } = await db
    .from('deliveries')
    .select('item_id')
    .eq('creator_id', creator.id)
    .in('item_id', candidatos.map((i) => i.id));

  if (erroDeliveries) throw new Error(`busca de deliveries: ${erroDeliveries.message}`);

  const jaAvaliados = new Set(
    ((existentes ?? []) as { item_id: string }[]).map((d) => d.item_id),
  );

  // Mais antigos primeiro: a fila anda em ordem de chegada.
  return candidatos
    .filter((item) => !jaAvaliados.has(item.id))
    .reverse()
    .slice(0, limite);
}

/**
 * Avalia os itens novos de cada criadora e grava um delivery pendente por item.
 *
 * O scorer é a única parte cara. Se ele falhar num item, o delivery entra como
 * `falho` com o erro registrado — assim o item não é retentado para sempre e a
 * rodada continua.
 */
export async function process(): Promise<ResumoProcess> {
  const criadoras = await criadorasAtivas();
  const resumo: ResumoProcess = { criadoras: criadoras.length, avaliados: 0, falhos: 0 };

  for (const creator of criadoras) {
    const nomesDeFonte = await fontesDaCriadora(creator.id);
    const itens = await itensPendentes(
      creator,
      [...nomesDeFonte.keys()],
      config.runtime.processLoteMax,
    );

    if (itens.length === 0) continue;

    logger.debug('itens a avaliar', { criadora: creator.nome, itens: itens.length });

    for (const item of itens) {
      const nomeFonte = nomesDeFonte.get(item.source_id) ?? 'fonte desconhecida';

      let registro: Record<string, unknown>;
      try {
        const nota = await pontuar({ creator, item, nomeFonte });

        registro = {
          creator_id: creator.id,
          item_id: item.id,
          score: nota.score,
          motivo_score: nota.motivo,
          resumo: nota.resumo,
          gancho: nota.gancho,
          status: 'pendente',
        };
        resumo.avaliados += 1;
      } catch (erro) {
        const mensagem = erro instanceof ErroScorer ? erro.message : String(erro);

        logger.error('scorer falhou', { criadora: creator.nome, itemId: item.id, titulo: item.titulo, erro });

        registro = {
          creator_id: creator.id,
          item_id: item.id,
          status: 'falho',
          erro: mensagem.slice(0, 1000),
        };
        resumo.falhos += 1;
      }

      // `ignoreDuplicates` protege o unique (creator_id, item_id) se duas
      // rodadas se sobrepuserem.
      const { error } = await db
        .from('deliveries')
        .upsert(registro, { onConflict: 'creator_id,item_id', ignoreDuplicates: true });

      if (error) {
        logger.error('falha ao gravar delivery', { criadora: creator.nome, itemId: item.id, erro: error.message });
      }
    }
  }

  logger.info('processamento concluído', { ...resumo });
  return resumo;
}
