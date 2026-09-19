-- A mesma notícia vinda de outra fonte.
--
-- O Deadline publica em inglês e, horas depois, CinePOP e Capricho publicam o
-- mesmo fato traduzido e com o título brasileiro. URL, slug e título mudam
-- todos, então nenhum dedupe da coleta pega — e a criadora recebia a mesma
-- escalação de elenco duas, três vezes.
--
-- A repetição vira delivery `descartado` apontando para o delivery que ela JÁ
-- recebeu. De quebra, o vínculo registra quantas fontes cobriram cada notícia.

alter table radar.deliveries
  add column if not exists duplicata_de uuid references radar.deliveries(id) on delete set null;

create index if not exists deliveries_duplicata_de_idx
  on radar.deliveries (duplicata_de)
  where duplicata_de is not null;

notify pgrst, 'reload schema';
