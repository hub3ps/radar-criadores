import { aplicarRegras } from '../core/regras.js';
import { formatarMensagem, normalizarWhatsapp } from '../core/formatter.js';
import { enviarTexto } from '../delivery/whatsapp.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import type { Creator, Delivery, Item } from '../db/types.js';

const logger = log.com({ job: 'dispatch' });

/** Depois disso o delivery vira `falho` em vez de ficar preso na fila para sempre. */
const MAX_TENTATIVAS = 3;

export interface ResumoDispatch {
  pendentes: number;
  enviados: number;
  descartados: number;
  adiados: number;
  falhos: number;
}

interface LinhaPendente {
  delivery: Delivery;
  item: Item;
  nomeFonte: string;
}

async function criadorasAtivas(): Promise<Creator[]> {
  const { data, error } = await db.from('creators').select('*').eq('ativo', true);
  if (error) throw new Error(`busca de criadoras: ${error.message}`);
  return (data ?? []) as Creator[];
}

/** Deliveries pendentes de uma criadora, os mais antigos primeiro. */
async function pendentesDe(creatorId: string, limite: number): Promise<LinhaPendente[]> {
  const { data, error } = await db
    .from('deliveries')
    .select('*, items(*, sources(nome))')
    .eq('creator_id', creatorId)
    .eq('status', 'pendente')
    .lt('tentativas', MAX_TENTATIVAS)
    .order('created_at', { ascending: true })
    .limit(limite);

  if (error) throw new Error(`busca de pendentes: ${error.message}`);

  type Aninhado = Delivery & {
    items: (Item & { sources: { nome: string } | { nome: string }[] | null }) | null;
  };

  const linhas: LinhaPendente[] = [];

  for (const bruto of (data ?? []) as unknown as Aninhado[]) {
    const { items, ...delivery } = bruto;
    if (!items) continue;

    const { sources, ...item } = items;
    const fonte = Array.isArray(sources) ? sources[0] : sources;

    linhas.push({ delivery, item, nomeFonte: fonte?.nome ?? 'fonte desconhecida' });
  }

  return linhas;
}

/** Quantas mensagens já saíram hoje, no fuso configurado. Insumo do teto diário. */
async function enviadosHoje(creatorId: string): Promise<number> {
  const agora = new Date();
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.runtime.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);

  // Meia-noite local expressa em UTC, via o offset atual do fuso.
  const meiaNoiteLocal = new Date(`${local}T00:00:00`);
  const offsetMs = meiaNoiteLocal.getTime() - new Date(`${local}T00:00:00Z`).getTime();
  const inicioDoDia = new Date(meiaNoiteLocal.getTime() - offsetMs).toISOString();

  const { count, error } = await db
    .from('deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('creator_id', creatorId)
    .eq('status', 'enviado')
    .gte('enviado_em', inicioDoDia);

  if (error) throw new Error(`contagem do dia: ${error.message}`);
  return count ?? 0;
}

/** Títulos já enviados dentro da janela de cooldown. Insumo do cooldown de tema. */
async function titulosRecentes(creatorId: string): Promise<string[]> {
  if (!config.regras.cooldownTemaAtivo) return [];

  const desde = new Date(
    Date.now() - config.regras.cooldownTemaHoras * 3_600_000,
  ).toISOString();

  const { data, error } = await db
    .from('deliveries')
    .select('items(titulo)')
    .eq('creator_id', creatorId)
    .eq('status', 'enviado')
    .gte('enviado_em', desde)
    .limit(200);

  if (error) throw new Error(`busca de títulos recentes: ${error.message}`);

  type Linha = { items: { titulo: string } | { titulo: string }[] | null };

  return ((data ?? []) as unknown as Linha[])
    .map((linha) => (Array.isArray(linha.items) ? linha.items[0] : linha.items))
    .map((item) => item?.titulo)
    .filter((titulo): titulo is string => typeof titulo === 'string');
}

/**
 * Manda as mensagens pendentes.
 *
 * Na fase de calibragem os quatro controles de ruído estão desligados, então
 * `aplicarRegras` libera tudo. O código já roda no caminho real — quando ligar,
 * não há nada novo para exercitar.
 */
export async function dispatch(): Promise<ResumoDispatch> {
  const resumo: ResumoDispatch = { pendentes: 0, enviados: 0, descartados: 0, adiados: 0, falhos: 0 };
  const criadoras = await criadorasAtivas();

  for (const creator of criadoras) {
    const pendentes = await pendentesDe(creator.id, config.runtime.dispatchLoteMax);
    if (pendentes.length === 0) continue;

    resumo.pendentes += pendentes.length;

    const numero = normalizarWhatsapp(creator.whatsapp);
    const recentes = await titulosRecentes(creator.id);

    // Contado uma vez por rodada e incrementado localmente: o teto é um limite
    // aproximado, não vale uma consulta extra por mensagem.
    let jaEnviadosHoje = config.regras.tetoDiarioAtivo ? await enviadosHoje(creator.id) : 0;

    for (const { delivery, item, nomeFonte } of pendentes) {
      const decisao = aplicarRegras(
        {
          score: delivery.score ?? 0,
          titulo: item.titulo,
          corteScore: creator.corte_score,
          tetoDia: creator.teto_dia,
          enviadosHoje: jaEnviadosHoje,
          janelaInicio: creator.janela_silencio_inicio,
          janelaFim: creator.janela_silencio_fim,
          titulosRecentes: recentes,
          agora: new Date(),
          timeZone: config.runtime.tz,
        },
        config.regras,
      );

      if (!decisao.liberado) {
        if (decisao.adiar) {
          // Continua pendente: sai na próxima rodada, quando a condição passar.
          resumo.adiados += 1;
          logger.debug('envio adiado', { deliveryId: delivery.id, motivo: decisao.motivo });
          // Teto e janela valem para a criadora inteira — não adianta tentar os outros.
          break;
        }

        await db
          .from('deliveries')
          .update({ status: 'descartado', erro: decisao.motivo ?? null })
          .eq('id', delivery.id);

        resumo.descartados += 1;
        logger.info('delivery descartado', { deliveryId: delivery.id, motivo: decisao.motivo });
        continue;
      }

      const texto = formatarMensagem({ delivery, item, nomeFonte });

      try {
        const { messageId } = await enviarTexto(numero, texto);

        await db
          .from('deliveries')
          .update({
            status: 'enviado',
            message_id: messageId,
            enviado_em: new Date().toISOString(),
            tentativas: delivery.tentativas + 1,
            erro: null,
          })
          .eq('id', delivery.id);

        jaEnviadosHoje += 1;
        recentes.push(item.titulo);
        resumo.enviados += 1;

        logger.info('mensagem enviada', {
          deliveryId: delivery.id,
          criadora: creator.nome,
          score: delivery.score,
          titulo: item.titulo,
        });
      } catch (erro) {
        const tentativas = delivery.tentativas + 1;
        const desistiu = tentativas >= MAX_TENTATIVAS;
        const mensagem = erro instanceof Error ? erro.message : String(erro);

        await db
          .from('deliveries')
          .update({
            tentativas,
            erro: mensagem.slice(0, 1000),
            ...(desistiu ? { status: 'falho' } : {}),
          })
          .eq('id', delivery.id);

        if (desistiu) resumo.falhos += 1;

        logger.error('falha no envio', {
          deliveryId: delivery.id,
          tentativas,
          desistiu,
          erro,
        });

        // Evolution fora do ar derruba todas as mensagens desta criadora —
        // não adianta insistir nas outras nesta rodada.
        break;
      }
    }
  }

  logger.info('dispatch concluído', { ...resumo });
  return resumo;
}
