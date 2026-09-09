-- Cadastro inicial da fase de calibragem: uma criadora e algumas fontes.
-- Troque os valores pelos reais antes de rodar. É idempotente: rodar de novo
-- não duplica nada.

-- ---------------------------------------------------------------------------
-- A criadora.
--
-- `perfil_texto` é o insumo principal do scorer — é ele que decide se um item
-- vale 9 ou 3 para ESTA pessoa. Vale caprichar: diga o que ela cobre, para quem
-- ela fala, que formato de vídeo ela faz e, principalmente, o que ela NÃO cobre.
-- ---------------------------------------------------------------------------
insert into radar.creators (nome, whatsapp, nicho, perfil_texto, corte_score, teto_dia, ativo)
values (
  'Nome da Criadora',
  '5511999998888',
  'finanças pessoais',
  'Fala de finanças pessoais para quem está começando a investir, com foco em '
  || 'renda fixa, contas digitais e mudanças que afetam o bolso no dia a dia. '
  || 'Faz vídeos curtos e verticais, tom direto, sem jargão de mercado. '
  || 'Cobre: bancos digitais, Tesouro Direto, CDB, mudanças em impostos e '
  || 'benefícios, golpes financeiros. Não cobre: cripto, day trade, análise de '
  || 'ações individuais, macroeconomia internacional.',
  0,   -- corte_score: 0 na calibragem (o filtro está desligado de qualquer jeito)
  0,   -- teto_dia: 0 = ilimitado
  true
)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- As fontes. 5 a 10 no total nesta fase.
-- `identificador`: URL do feed (rss) ou handle sem arroba (instagram, tiktok).
-- ---------------------------------------------------------------------------
insert into radar.sources (tipo, identificador, nome, ativo)
values
  ('rss',       'https://g1.globo.com/rss/g1/economia/', 'G1 Economia',   true),
  ('rss',       'https://www.infomoney.com.br/feed/',    'InfoMoney',     true),
  ('instagram', 'bancocentraldobrasil',                  'BC no Insta',   true),
  ('tiktok',    'nubank',                                'Nubank TikTok', true)
on conflict (tipo, identificador) do nothing;

-- ---------------------------------------------------------------------------
-- Liga a criadora a todas as fontes ativas.
-- ---------------------------------------------------------------------------
insert into radar.creator_sources (creator_id, source_id)
select c.id, s.id
from radar.creators c
cross join radar.sources s
where c.nome = 'Nome da Criadora'
  and s.ativo
on conflict do nothing;
