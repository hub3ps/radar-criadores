-- Idempotência do cadastro.
--
-- A etapa de sites pode demorar: cada site indicado exige descobrir o feed, e
-- um site sem RSS custa vários segundos até esgotar os caminhos. Se a Evolution
-- der timeout e reenviar o webhook, a máquina de estados avançaria duas vezes
-- com a mesma mensagem — pulando uma pergunta.
alter table radar.onboardings
  add column if not exists ultima_mensagem_id text;
