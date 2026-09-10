-- Separa "o que faz gravar" de "o que nunca cobriria".
--
-- A pergunta 2 do cadastro juntava três coisas: que novidade te faz gravar,
-- para quem você fala, e o que não te interessa. A primeira criadora respondeu
-- só a do meio — a mais fácil — e o perfil resultante descrevia a audiência,
-- não a cobertura. O scorer perde o que mais discrimina: o que ela NÃO cobre.

alter table radar.onboardings
  add column if not exists cobre text,
  add column if not exists evita text;

alter table radar.onboardings drop constraint if exists onboardings_etapa_check;
alter table radar.onboardings add constraint onboardings_etapa_check
  check (etapa in ('nicho','perfil','cobre','evita','sites','instagram','tiktok','confirmacao','concluido'));
