/**
 * Os quatro controles de ruído.
 *
 * Na fase de calibragem todos estão DESLIGADOS por `.env` — o sistema manda tudo,
 * para descobrirmos onde o corte deve ficar. O código existe e é testado; ligar
 * é trocar `false` por `true` no `.env`, sem tocar em nada aqui.
 *
 * Todas as funções são puras: recebem o estado já lido do banco e devolvem uma
 * decisão. Quem consulta o banco é o `dispatch`.
 */

export interface Decisao {
  /** false = a mensagem não vai agora. */
  liberado: boolean;
  /** Por que foi barrada. Vira `deliveries.erro` quando o status é `descartado`. */
  motivo?: string;
  /** true = tenta de novo depois (janela de silêncio). false = descarta de vez. */
  adiar?: boolean;
}

const LIBERADO: Decisao = { liberado: true };

// ---------------------------------------------------------------------------
// 1. Filtro de score
// ---------------------------------------------------------------------------

/** Barra o que ficou abaixo do corte da criadora. Descarta de vez: a nota não muda. */
export function filtroScore(score: number, corteScore: number, ativo: boolean): Decisao {
  if (!ativo) return LIBERADO;
  if (score >= corteScore) return LIBERADO;

  return {
    liberado: false,
    motivo: `score ${score} abaixo do corte ${corteScore}`,
    adiar: false,
  };
}

// ---------------------------------------------------------------------------
// 2. Teto diário
// ---------------------------------------------------------------------------

/**
 * Segura o envio quando a criadora já recebeu o máximo do dia.
 * Adia em vez de descartar — amanhã a cota zera e o item ainda pode valer.
 * `tetoDia = 0` significa ilimitado.
 */
export function tetoDiario(enviadosHoje: number, tetoDia: number, ativo: boolean): Decisao {
  if (!ativo || tetoDia <= 0) return LIBERADO;
  if (enviadosHoje < tetoDia) return LIBERADO;

  return {
    liberado: false,
    motivo: `teto diário atingido (${enviadosHoje}/${tetoDia})`,
    adiar: true,
  };
}

// ---------------------------------------------------------------------------
// 3. Janela de silêncio
// ---------------------------------------------------------------------------

/** `"22:30"` ou `"22:30:00"` → minutos desde a meia-noite. */
function paraMinutos(hora: string): number | null {
  const partes = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hora.trim());
  if (!partes) return null;

  const h = Number(partes[1]);
  const m = Number(partes[2]);
  if (h > 23 || m > 59) return null;

  return h * 60 + m;
}

/** Hora local (no fuso informado) de um instante, em minutos desde a meia-noite. */
export function minutosLocais(agora: Date, timeZone: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(agora);

  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');

  // Intl pode devolver "24" para meia-noite em hour12:false.
  return (hora % 24) * 60 + minuto;
}

/**
 * Segura a mensagem dentro da janela em que a criadora não quer ser incomodada.
 * Sempre adia: passada a janela, a mensagem sai.
 *
 * A janela pode virar o dia (`22:00`–`07:00`) — nesse caso o intervalo é a união
 * de `22:00→24:00` e `00:00→07:00`.
 */
export function janelaSilencio(
  agora: Date,
  inicio: string | null,
  fim: string | null,
  ativo: boolean,
  timeZone: string,
): Decisao {
  if (!ativo || !inicio || !fim) return LIBERADO;

  const de = paraMinutos(inicio);
  const ate = paraMinutos(fim);
  if (de === null || ate === null || de === ate) return LIBERADO;

  const agoraMin = minutosLocais(agora, timeZone);
  const dentro = de < ate ? agoraMin >= de && agoraMin < ate : agoraMin >= de || agoraMin < ate;

  if (!dentro) return LIBERADO;

  return {
    liberado: false,
    motivo: `dentro da janela de silêncio (${inicio}–${fim})`,
    adiar: true,
  };
}

// ---------------------------------------------------------------------------
// 4. Cooldown de tema
// ---------------------------------------------------------------------------

const VAZIAS = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pra', 'com', 'sem', 'sob', 'sobre',
  'e', 'ou', 'que', 'se', 'ao', 'aos', 'à', 'às', 'the', 'of', 'to', 'in', 'on',
]);

/** Título → conjunto de palavras significativas, sem acento e sem pontuação. */
export function tokenizar(titulo: string): Set<string> {
  const palavras = titulo
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 2 && !VAZIAS.has(p));

  return new Set(palavras);
}

/** Jaccard entre dois títulos: 0 = nada em comum, 1 = mesmas palavras. */
export function similaridade(a: string, b: string): number {
  const tokensA = tokenizar(a);
  const tokensB = tokenizar(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersecao = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersecao += 1;

  const uniao = tokensA.size + tokensB.size - intersecao;
  return uniao === 0 ? 0 : intersecao / uniao;
}

/** Acima disso dois títulos são tratados como a mesma novidade contada de outro jeito. */
export const LIMIAR_TEMA = 0.5;

/**
 * Evita mandar a mesma novidade duas vezes só porque duas fontes cobriram.
 * `titulosRecentes` são os títulos já enviados dentro da janela de cooldown.
 * Descarta de vez: se já foi entregue por outra fonte, não vale reenviar depois.
 */
export function cooldownTema(
  titulo: string,
  titulosRecentes: readonly string[],
  ativo: boolean,
  limiar: number = LIMIAR_TEMA,
): Decisao {
  if (!ativo) return LIBERADO;

  for (const recente of titulosRecentes) {
    const grau = similaridade(titulo, recente);
    if (grau >= limiar) {
      return {
        liberado: false,
        motivo: `tema repetido (${grau.toFixed(2)} de similaridade com "${recente}")`,
        adiar: false,
      };
    }
  }

  return LIBERADO;
}

// ---------------------------------------------------------------------------
// Composição
// ---------------------------------------------------------------------------

export interface EstadoRegras {
  score: number;
  titulo: string;
  corteScore: number;
  tetoDia: number;
  enviadosHoje: number;
  janelaInicio: string | null;
  janelaFim: string | null;
  titulosRecentes: readonly string[];
  agora: Date;
  timeZone: string;
}

export interface ChavesRegras {
  filtroScoreAtivo: boolean;
  tetoDiarioAtivo: boolean;
  janelaSilencioAtiva: boolean;
  cooldownTemaAtivo: boolean;
}

/**
 * Roda os quatro na ordem do mais barato para o mais caro de reverter:
 * o que descarta de vez vem antes do que só adia.
 */
export function aplicarRegras(estado: EstadoRegras, chaves: ChavesRegras): Decisao {
  const etapas = [
    filtroScore(estado.score, estado.corteScore, chaves.filtroScoreAtivo),
    cooldownTema(estado.titulo, estado.titulosRecentes, chaves.cooldownTemaAtivo),
    tetoDiario(estado.enviadosHoje, estado.tetoDia, chaves.tetoDiarioAtivo),
    janelaSilencio(
      estado.agora,
      estado.janelaInicio,
      estado.janelaFim,
      chaves.janelaSilencioAtiva,
      estado.timeZone,
    ),
  ];

  for (const decisao of etapas) {
    if (!decisao.liberado) return decisao;
  }

  return LIBERADO;
}
