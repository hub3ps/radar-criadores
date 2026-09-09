import { z } from 'zod';
import { descobrirFeed } from '../collectors/descoberta.js';
import { pedirJson } from '../core/openrouter.js';
import { variantesWhatsapp } from '../core/formatter.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { log } from '../logger.js';
import type { Onboarding, EtapaOnboarding } from '../db/types.js';

/**
 * Cadastro conversacional pelo WhatsApp.
 *
 * Roteiro fixo: uma pergunta por vez, na ordem. O modelo entra só para
 * interpretar a resposta livre dela — achar handles e domínios no meio de
 * "quero o deadline e o @variety" — e nunca para conduzir a conversa. Isso
 * mantém o fluxo previsível e barato, e o estado vive no banco porque o
 * processo reinicia a cada deploy.
 */
const logger = log.com({ componente: 'onboarding' });

/** Vem do `.env` (`CADASTRO_MAX_FONTES`): na fase de testes vale abrir mais. */
const MAX_POR_TIPO = config.runtime.cadastroMaxFontes;

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const PERGUNTAS: Record<Exclude<EtapaOnboarding, 'concluido'>, string> = {
  nicho:
    'Oi! Eu sou o radar 👋\n\n' +
    'Eu vigio as fontes que você escolher e te aviso no WhatsApp assim que sai ' +
    'alguma novidade que vale virar vídeo — com um resumo e um gancho pronto.\n\n' +
    'Vamos te cadastrar em 5 perguntas rápidas.\n\n' +
    '*1 de 5* — Qual é o nicho do seu conteúdo?',

  perfil:
    '*2 de 5* — Me conta com detalhe o que você procura.\n\n' +
    'Que tipo de novidade te faz querer gravar? Para quem você fala? ' +
    'E o que definitivamente *não* te interessa?\n\n' +
    'Quanto mais específico, melhor eu acerto. Pode escrever à vontade.',

  sites:
    `*3 de 5* — Quais sites você quer que eu acompanhe? (até ${MAX_POR_TIPO})\n\n` +
    'Pode mandar o endereço ou só o nome, um por linha.',

  instagram:
    `*4 de 5* — Quais perfis do Instagram? (até ${MAX_POR_TIPO})\n\n` +
    'Manda o @ de cada um. Se não quiser nenhum, responde *pular*.',

  tiktok:
    `*5 de 5* — E do TikTok? (até ${MAX_POR_TIPO})\n\n` +
    'Manda o @ de cada um. Se não quiser nenhum, responde *pular*.',

  confirmacao: '',
};

const NAO_CONVIDADA =
  'Oi! Esse número é do radar de criadores, um serviço em fase fechada de testes.\n\n' +
  'No momento só quem foi convidado consegue se cadastrar. Se você deveria ter acesso, ' +
  'fala com quem te passou o contato.';

// ---------------------------------------------------------------------------
// Extração das respostas livres
// ---------------------------------------------------------------------------

const Fontes = z.object({
  itens: z.array(z.string()).describe('Cada site ou perfil citado, um por elemento'),
  pular: z.boolean().describe('true se a pessoa disse que não quer nenhum'),
});

/**
 * Tira de um texto livre a lista de sites ou perfis citados.
 * O modelo só normaliza — não decide nada sobre o cadastro.
 */
export async function extrairFontes(
  texto: string,
  tipo: 'site' | 'instagram' | 'tiktok',
): Promise<{ itens: string[]; pular: boolean }> {
  const oQue =
    tipo === 'site'
      ? 'sites de notícia (devolva o domínio, ex.: "deadline.com")'
      : `perfis do ${tipo === 'instagram' ? 'Instagram' : 'TikTok'} (devolva só o handle, sem @)`;

  const saida = await pedirJson(
    {
      system:
        `Você extrai ${oQue} de uma mensagem de WhatsApp.\n\n` +
        'Regras: devolva apenas o que a pessoa citou, sem inventar nada. ' +
        'Se ela disse que não quer nenhum, ou disse "pular", "nenhum", "não", ' +
        'marque pular=true e devolva itens vazio. ' +
        'Não invente domínios nem perfis que ela não escreveu.',
      user: texto,
      nome: 'extracao_fontes',
      maxTokens: 1000,
    },
    Fontes,
  );

  return {
    itens: saida.itens.map((i) => i.trim()).filter((i) => i !== '').slice(0, MAX_POR_TIPO),
    pular: saida.pular,
  };
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** O convite que corresponde a este número, casando as variantes do nono dígito. */
export async function conviteDe(numero: string): Promise<string | null> {
  const { data, error } = await db.from('convites').select('whatsapp');
  if (error) throw new Error(`consulta de convites: ${error.message}`);

  const doNumero = new Set(variantesWhatsapp(numero));
  const achado = ((data ?? []) as { whatsapp: string }[]).find((c) =>
    variantesWhatsapp(c.whatsapp).some((v) => doNumero.has(v)),
  );
  return achado?.whatsapp ?? null;
}

export async function convidada(numero: string): Promise<boolean> {
  return (await conviteDe(numero)) !== null;
}

export async function onboardingDe(numero: string): Promise<Onboarding | null> {
  const { data, error } = await db.from('onboardings').select('*');
  if (error) throw new Error(`consulta de onboarding: ${error.message}`);

  const doNumero = new Set(variantesWhatsapp(numero));
  const achado = ((data ?? []) as Onboarding[]).find((o) =>
    variantesWhatsapp(o.whatsapp).some((v) => doNumero.has(v)),
  );
  return achado ?? null;
}

async function salvar(id: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('onboardings')
    .update({ ...campos, atualizado_em: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`gravação de onboarding: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Resumo e conclusão
// ---------------------------------------------------------------------------

function listar(rotulo: string, itens: string[], prefixo = ''): string {
  if (itens.length === 0) return `${rotulo}: (nenhum)`;
  return `${rotulo}:\n${itens.map((i) => `  • ${prefixo}${i}`).join('\n')}`;
}

export function montarResumo(o: Onboarding): string {
  return [
    'Fechou! Confere se está certo:',
    '',
    `*Nicho:* ${o.nicho ?? '—'}`,
    '',
    `*O que você procura:*\n${o.perfil_texto ?? '—'}`,
    '',
    listar('*Sites*', o.sites.map((s) => s.nome)),
    listar('*Instagram*', o.instagram, '@'),
    listar('*TikTok*', o.tiktok, '@'),
    '',
    'Está certo? Responde *sim* para eu ativar, ou *não* para recomeçar.',
  ].join('\n');
}

/** Cria a criadora e as fontes. Só roda depois do "sim". */
async function concluir(o: Onboarding): Promise<string> {
  // O JID do WhatsApp pode vir sem o nono dígito, e é dele que sai `o.whatsapp`.
  // O número do convite foi digitado por quem opera e é a forma que já sabemos
  // que a Evolution aceita no envio — por isso ele tem preferência.
  const paraEnvio = (await conviteDe(o.whatsapp)) ?? o.whatsapp;

  if (paraEnvio !== o.whatsapp) {
    logger.info('número normalizado pelo convite', { doJid: o.whatsapp, doConvite: paraEnvio });
  }

  const { data: criada, error: erroCreator } = await db
    .from('creators')
    .insert({
      nome: o.nicho ? `Criadora — ${o.nicho}`.slice(0, 60) : 'Criadora',
      whatsapp: paraEnvio,
      nicho: o.nicho,
      perfil_texto: o.perfil_texto ?? '',
      ativo: true,
    })
    .select('id')
    .single();

  if (erroCreator) throw new Error(`criação da criadora: ${erroCreator.message}`);
  const creatorId = (criada as { id: string }).id;

  const fontes = [
    ...o.sites.map((s) => ({ tipo: 'rss' as const, identificador: s.feed, nome: s.nome })),
    ...o.instagram.map((h) => ({ tipo: 'instagram' as const, identificador: h, nome: `@${h} (Instagram)` })),
    ...o.tiktok.map((h) => ({ tipo: 'tiktok' as const, identificador: h, nome: `@${h} (TikTok)` })),
  ];

  if (fontes.length > 0) {
    const { error } = await db
      .from('sources')
      .upsert(fontes.map((f) => ({ ...f, ativo: true })), {
        onConflict: 'tipo,identificador',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`criação de fontes: ${error.message}`);

    // Busca os ids (o upsert com ignoreDuplicates não devolve as linhas existentes).
    const { data: gravadas, error: erroBusca } = await db
      .from('sources')
      .select('id, tipo, identificador')
      .in('identificador', fontes.map((f) => f.identificador));

    if (erroBusca) throw new Error(`busca de fontes: ${erroBusca.message}`);

    const vinculos = ((gravadas ?? []) as { id: string; tipo: string; identificador: string }[])
      .filter((g) => fontes.some((f) => f.tipo === g.tipo && f.identificador === g.identificador))
      .map((g) => ({ creator_id: creatorId, source_id: g.id }));

    if (vinculos.length > 0) {
      const { error: erroVinculo } = await db
        .from('creator_sources')
        .upsert(vinculos, { onConflict: 'creator_id,source_id', ignoreDuplicates: true });
      if (erroVinculo) throw new Error(`vínculo criadora-fonte: ${erroVinculo.message}`);
    }
  }

  await salvar(o.id, { etapa: 'concluido', creator_id: creatorId });
  await db.from('convites').update({ usado_em: new Date().toISOString() }).eq('whatsapp', o.whatsapp);

  logger.info('cadastro concluído', {
    creatorId,
    whatsapp: o.whatsapp,
    sites: o.sites.length,
    instagram: o.instagram.length,
    tiktok: o.tiktok.length,
  });

  const social = o.instagram.length + o.tiktok.length;
  const avisoSocial =
    social > 0 && config.apify.dryRun
      ? '\n\nOs perfis de Instagram e TikTok ficam registrados, mas ainda estão em ativação — ' +
        'por enquanto os alertas vêm dos sites.'
      : '';

  return (
    'Pronto, você está no ar! 🎯\n\n' +
    'A partir de agora eu vigio suas fontes e te aviso assim que sair algo que vale gravar.\n\n' +
    'Em cada alerta, responde *1* (gravaria), *2* (talvez) ou *3* (lixo) — ' +
    'é assim que eu aprendo o seu gosto e paro de te mandar o que não presta.' +
    avisoSocial
  );
}

// ---------------------------------------------------------------------------
// A conversa
// ---------------------------------------------------------------------------

export interface RespostaOnboarding {
  /** Texto a enviar de volta. `null` = não responder nada. */
  texto: string | null;
  concluido?: boolean;
}

/** Começa um cadastro. Chamado quando um número desconhecido escreve. */
export async function iniciar(numero: string): Promise<RespostaOnboarding> {
  if (!(await convidada(numero))) {
    logger.info('número não convidado tentou cadastro', { numero });
    return { texto: NAO_CONVIDADA };
  }

  const { error } = await db.from('onboardings').insert({ whatsapp: numero, etapa: 'nicho' });
  if (error) throw new Error(`criação de onboarding: ${error.message}`);

  logger.info('cadastro iniciado', { numero });
  return { texto: PERGUNTAS.nicho };
}

/** Processa uma resposta dela dentro do cadastro em andamento. */
export async function responder(
  o: Onboarding,
  texto: string,
  mensagemId: string | null = null,
): Promise<RespostaOnboarding> {
  const limpo = texto.trim();
  if (limpo === '') return { texto: null };

  // Reenvio do mesmo webhook não pode avançar a etapa de novo.
  if (mensagemId !== null && o.ultima_mensagem_id === mensagemId) {
    logger.debug('webhook de cadastro duplicado ignorado', { mensagemId, etapa: o.etapa });
    return { texto: null };
  }

  const avancar = (campos: Record<string, unknown>) =>
    salvar(o.id, { ...campos, ultima_mensagem_id: mensagemId });

  switch (o.etapa) {
    case 'nicho': {
      await avancar({ nicho: limpo.slice(0, 120), etapa: 'perfil' });
      return { texto: PERGUNTAS.perfil };
    }

    case 'perfil': {
      await avancar({ perfil_texto: limpo.slice(0, 4000), etapa: 'sites' });
      return { texto: PERGUNTAS.sites };
    }

    case 'sites': {
      const { itens, pular } = await extrairFontes(limpo, 'site');

      if (pular || itens.length === 0) {
        await avancar({ etapa: 'instagram' });
        return { texto: `Sem sites então.\n\n${PERGUNTAS.instagram}` };
      }

      // Em paralelo de propósito: sequencial, cinco sites levariam mais de
      // trinta segundos no pior caso, a Evolution daria timeout e reenviaria o
      // webhook. Assim o tempo é o do site mais lento, não a soma.
      const resultados = await Promise.all(
        itens.map(async (item) => ({ item, feed: await descobrirFeed(item) })),
      );
      const achados = resultados.flatMap((r) => (r.feed ? [r.feed] : []));
      const faltaram = resultados.filter((r) => !r.feed).map((r) => r.item);

      if (achados.length === 0) {
        // Fica na mesma etapa e pede outro, mas registra a mensagem: um reenvio
        // não deve pagar a descoberta de novo.
        await avancar({ etapa: 'sites' });
        return {
          texto:
            `Não achei feed de notícias em ${faltaram.join(' nem ')}. 😕\n\n` +
            'Nem todo site publica RSS, e sem isso eu não consigo acompanhar.\n\n' +
            'Me indica outro site?',
        };
      }

      await avancar({ sites: achados, etapa: 'instagram' });

      const aviso =
        faltaram.length > 0
          ? `\n\n(Não consegui ${faltaram.join(' nem ')} — esse site não publica RSS.)`
          : '';

      return {
        texto: `Anotado: ${achados.map((a) => a.nome).join(', ')}.${aviso}\n\n${PERGUNTAS.instagram}`,
      };
    }

    case 'instagram': {
      const { itens, pular } = await extrairFontes(limpo, 'instagram');
      await avancar({ instagram: pular ? [] : itens, etapa: 'tiktok' });
      return { texto: PERGUNTAS.tiktok };
    }

    case 'tiktok': {
      const { itens, pular } = await extrairFontes(limpo, 'tiktok');
      await avancar({ tiktok: pular ? [] : itens, etapa: 'confirmacao' });

      const atual = await onboardingDe(o.whatsapp);
      return { texto: montarResumo(atual ?? { ...o, tiktok: pular ? [] : itens }) };
    }

    case 'confirmacao': {
      if (/^(sim|s|isso|confirmo|ok|pode|certo|correto)\b/i.test(limpo)) {
        const atual = (await onboardingDe(o.whatsapp)) ?? o;
        return { texto: await concluir(atual), concluido: true };
      }

      if (/^(n[ãa]o|n|refazer|errado|corrigir)\b/i.test(limpo)) {
        await avancar({
          etapa: 'nicho',
          nicho: null,
          perfil_texto: null,
          sites: [],
          instagram: [],
          tiktok: [],
        });
        return { texto: `Sem problema, vamos de novo.\n\n${PERGUNTAS.nicho}` };
      }

      return { texto: 'Só para eu ter certeza: responde *sim* para ativar ou *não* para recomeçar.' };
    }

    case 'concluido':
      return { texto: null };
  }
}
