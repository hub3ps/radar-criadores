-- Idempotência do feedback.
--
-- Uma resposta 1/2/3 pode chegar mais de uma vez: webhook global e por-instância
-- configurados juntos, ou reenvio da Evolution depois de timeout. Sem marcar qual
-- mensagem de entrada gerou o feedback, a cópia duplicada não era reconhecida e
-- ia gravar no PRÓXIMO delivery da fila — inventando resposta que ninguém deu.

alter table radar.deliveries
  add column if not exists feedback_message_id text;

-- A mesma mensagem de entrada não pode pontuar dois deliveries.
create unique index if not exists deliveries_feedback_message_id_key
  on radar.deliveries (feedback_message_id)
  where feedback_message_id is not null;
