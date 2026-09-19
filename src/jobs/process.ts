import { filtroScore } from '../core/regras.js';
import { jaRecebida, type Recebido, type Repeticao } from '../core/repetidas.js';
import { ErroScorer, pontuar } from '../core/scorer.js';
import { triar } from '../core/triagem.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import type { Creator, Item } from '../db/types.js';

const logger = log.com({ job: 'process' });

export interface ResumoProcess {
  criadoras: number;
  avaliados: number;
  falhos: number;
  /** Descartados na triagem, sem chegar ao modelo caro. */
  triados: number;
  /** Pontuados, mas eram a mesma notícia que ela já recebeu por outra fonte. */
  repetidos: number;
}

/**
 * Por quanto tempo o que ela recebeu continua valendo como "já recebido".
 * O maior atraso medido entre o Deadline e a versão traduzida foi de 26 h.
 */
const JANELA_REPETICAO_HORAS = 72;

/** Teto da lista que o modelo lê, para o prompt não crescer sem limite num dia de enxurrada. */
const LIMITE_RECEBIDOS = 80;

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
 * Triagem: a nota barata decide quem chega ao modelo caro.
 *
 * Devolve `null` quando o item passa, ou o registro de descarte quando não.
 * Se a triagem falhar, o item PASSA — uma falha de infraestrutura não pode
 * custar uma novidade boa, e o custo de um scorer a mais é irrelevante perto
 * disso. Medido em 154 itens reais: nenhum item bom recebeu triagem abaixo de
 * 7, contra um corte de 4.
 */
async function descartadoNaTriagem(
  creator: Creator,
  item: Item,
  nomeFonte: string,
): Promise<Record<string, unknown> | null> {
  if (!config.runtime.triagemAtiva) return null;

  let nota: number;
  try {
    nota = await triar({ creator, item, nomeFonte });
  } catch (erro) {
    logger.warn('triagem falhou — item segue para o scorer', { itemId: item.id, erro });
    return null;
  }

  if (nota >= config.runtime.triagemCorte) return null;

  return {
    creator_id: creator.id,
    item_id: item.id,
    score: nota,
    motivo_score: `descartado na triagem (${nota} < ${config.runtime.triagemCorte})`,
    status: 'descartado',
  };
}

/**
 * O que ela já recebeu ou vai receber: enviados, e pendentes que passam do
 * corte, os mais recentes primeiro. Descartados e falhos ficam de fora — se a
 * primeira versão não chegou até ela, a segunda não é repetição.
 */
async function recebidosRecentes(creator: Creator): Promise<Recebido[]> {
  const desde = new Date(Date.now() - JANELA_REPETICAO_HORAS * 3_600_000).toISOString();

  const base = db
    .from('deliveries')
    .select('id, resumo, items(titulo, sources(nome))')
    .eq('creator_id', creator.id)
    .gte('created_at', desde);

  // Pendente abaixo do corte vai ser descartado pelo dispatch: não chega nela.
  const filtrada = config.regras.filtroScoreAtivo
    ? base.or(`status.eq.enviado,and(status.eq.pendente,score.gte.${creator.corte_score})`)
    : base.in('status', ['pendente', 'enviado']);

  const { data, error } = await filtrada
    .order('created_at', { ascending: false })
    .limit(LIMITE_RECEBIDOS);

  if (error) throw new Error(`busca do que ela já recebeu: ${error.message}`);

  // O join do PostgREST devolve objeto ou lista de um item, conforme a FK.
  type UmOuLista<T> = T | T[] | null;
  type Linha = {
    id: string;
    resumo: string | null;
    items: UmOuLista<{ titulo: string; sources: UmOuLista<{ nome: string }> }>;
  };
  const primeiro = <T>(v: UmOuLista<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

  const recebidos: Recebido[] = [];
  for (const linha of (data ?? []) as unknown as Linha[]) {
    const item = primeiro(linha.items);
    if (!item) continue;
    recebidos.push({
      id: linha.id,
      titulo: item.titulo,
      resumo: linha.resumo,
      nomeFonte: primeiro(item.sources)?.nome ?? 'fonte desconhecida',
    });
  }
  return recebidos;
}

/**
 * A mesma notícia que ela já recebeu, vinda de outra fonte?
 *
 * Roda DEPOIS do scorer, e só no item que vai chegar nela. Antes do scorer
 * pouparia o modelo caro nas repetições, mas a checagem rodaria em todo item
 * que passa da triagem — e a maioria deles cai no corte de nota em seguida.
 * Repetição é rara (3 em 85 envios); item pontuado abaixo do corte, não. Assim
 * a checagem roda umas poucas vezes por dia, e compara resumo com resumo.
 *
 * Falha aqui deixa o item passar, pela mesma razão da triagem: o pior caso vira
 * uma mensagem repetida, nunca uma novidade perdida.
 */
async function repeticaoDe(
  creator: Creator,
  item: Item,
  novo: Omit<Recebido, 'id'>,
  recebidos: readonly Recebido[],
): Promise<Repeticao | null> {
  if (!config.runtime.barrarRepetidas) return null;

  let repeticao: Repeticao | null;
  try {
    repeticao = await jaRecebida({ novo, recebidos });
  } catch (erro) {
    logger.warn('checagem de repetição falhou — item segue para envio', { itemId: item.id, erro });
    return null;
  }

  if (repeticao) {
    logger.info('notícia repetida barrada', {
      criadora: creator.nome,
      titulo: item.titulo,
      fonte: novo.nomeFonte,
      original: repeticao.original.titulo,
      fonteOriginal: repeticao.original.nomeFonte,
    });
  }
  return repeticao;
}

/**
 * Avalia os itens novos de cada criadora e grava um delivery pendente por item.
 *
 * O scorer é a única parte cara. Se ele falhar num item, o delivery entra como
 * `falho` com o erro registrado — assim o item não é retentado para sempre e a
 * rodada continua.
 *
 * Antes dele roda a triagem, que é barata e só dá nota. Quem não passa vira
 * delivery `descartado` — precisa virar linha no banco, senão o item seria
 * triado de novo a cada rodada e a economia evaporaria.
 *
 * Depois dele, o item que vai chegar nela passa pela checagem de repetição.
 * Repetido vira `descartado` com a nota e o resumo guardados, e `duplicata_de`
 * apontando para o que ela já recebeu.
 */
export async function process(): Promise<ResumoProcess> {
  const criadoras = await criadorasAtivas();
  const resumo: ResumoProcess = {
    criadoras: criadoras.length,
    avaliados: 0,
    falhos: 0,
    triados: 0,
    repetidos: 0,
  };

  for (const creator of criadoras) {
    const nomesDeFonte = await fontesDaCriadora(creator.id);
    const itens = await itensPendentes(
      creator,
      [...nomesDeFonte.keys()],
      config.runtime.processLoteMax,
    );

    if (itens.length === 0) continue;

    logger.debug('itens a avaliar', { criadora: creator.nome, itens: itens.length });

    // Lido uma vez por rodada e atualizado a cada item aprovado: se o Deadline e
    // a Capricho chegam na mesma rodada, a segunda já enxerga a primeira.
    const recebidos = config.runtime.barrarRepetidas ? await recebidosRecentes(creator) : [];

    for (const item of itens) {
      const nomeFonte = nomesDeFonte.get(item.source_id) ?? 'fonte desconhecida';

      const descarte = await descartadoNaTriagem(creator, item, nomeFonte);
      if (descarte) {
        const { error } = await db
          .from('deliveries')
          .upsert(descarte, { onConflict: 'creator_id,item_id', ignoreDuplicates: true });
        if (error) {
          logger.error('falha ao gravar descarte', { itemId: item.id, erro: error.message });
        }
        resumo.triados += 1;
        continue;
      }

      let registro: Record<string, unknown>;
      let aprovado: Omit<Recebido, 'id'> | null = null;
      try {
        const nota = await pontuar({ creator, item, nomeFonte });

        const novo = { titulo: item.titulo, resumo: nota.resumo, nomeFonte };
        const chega = filtroScore(nota.score, creator.corte_score, config.regras.filtroScoreAtivo).liberado;
        const repeticao = chega ? await repeticaoDe(creator, item, novo, recebidos) : null;

        registro = {
          creator_id: creator.id,
          item_id: item.id,
          score: nota.score,
          motivo_score: nota.motivo,
          resumo: nota.resumo,
          gancho: nota.gancho,
          status: 'pendente',
          // Como os descartes do dispatch: o motivo vai em `erro`, e a nota do
          // scorer fica intacta em `motivo_score`.
          ...(repeticao && {
            status: 'descartado',
            erro: `repete o que ela já recebeu: ${repeticao.motivo}`,
            duplicata_de: repeticao.original.id,
          }),
        };

        if (repeticao) resumo.repetidos += 1;
        else if (chega) aprovado = novo;
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
      const { data: gravado, error } = await db
        .from('deliveries')
        .upsert(registro, { onConflict: 'creator_id,item_id', ignoreDuplicates: true })
        .select('id');

      if (error) {
        logger.error('falha ao gravar delivery', { criadora: creator.nome, itemId: item.id, erro: error.message });
      }

      const id = (gravado as { id: string }[] | null)?.[0]?.id;
      if (aprovado && id) recebidos.unshift({ id, ...aprovado });
    }
  }

  logger.info('processamento concluído', { ...resumo });
  return resumo;
}
