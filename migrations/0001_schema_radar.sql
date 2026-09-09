-- radar-criadores — schema inicial
-- Aplicar no Supabase (SQL Editor ou psql). Idempotente: pode rodar de novo sem estragar nada.

create schema if not exists radar;

-- ---------------------------------------------------------------------------
-- creators — uma criadora por linha. Na fase de calibragem existe só uma.
-- ---------------------------------------------------------------------------
create table if not exists radar.creators (
  id                     uuid primary key default gen_random_uuid(),
  nome                   text        not null,
  whatsapp               text        not null,
  nicho                  text,
  -- Descrição longa do que ela cobre. É o insumo principal do scorer:
  -- quanto mais específico, melhor a nota.
  perfil_texto           text        not null,
  corte_score            smallint    not null default 0 check (corte_score between 0 and 10),
  teto_dia               smallint    not null default 0 check (teto_dia >= 0), -- 0 = ilimitado
  janela_silencio_inicio time,
  janela_silencio_fim    time,
  ativo                  boolean     not null default true,
  created_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- sources — feeds e perfis monitorados. 5 a 10 no total nesta fase.
-- ---------------------------------------------------------------------------
create table if not exists radar.sources (
  id            uuid primary key default gen_random_uuid(),
  tipo          text        not null check (tipo in ('rss', 'instagram', 'tiktok')),
  -- URL do feed (rss) ou @handle sem o arroba (instagram, tiktok)
  identificador text        not null,
  nome          text        not null,
  ativo         boolean     not null default true,
  ultima_coleta timestamptz,
  created_at    timestamptz not null default now(),
  unique (tipo, identificador)
);

-- ---------------------------------------------------------------------------
-- creator_sources — n:n entre criadoras e fontes
-- ---------------------------------------------------------------------------
create table if not exists radar.creator_sources (
  creator_id uuid        not null references radar.creators(id) on delete cascade,
  source_id  uuid        not null references radar.sources(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (creator_id, source_id)
);

create index if not exists creator_sources_source_idx on radar.creator_sources (source_id);

-- ---------------------------------------------------------------------------
-- items — tudo que foi coletado, deduplicado por url_hash
-- ---------------------------------------------------------------------------
create table if not exists radar.items (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid        not null references radar.sources(id) on delete cascade,
  url          text        not null,
  -- sha256 da URL canonicalizada (sem utm_*, sem fragmento, sem barra final)
  url_hash     text        not null,
  titulo       text        not null,
  texto        text,
  autor        text,
  publicado_em timestamptz,
  coletado_em  timestamptz not null default now(),
  -- false = veio no backfill da primeira coleta de uma fonte nova.
  -- Fica gravado para o dedupe funcionar, mas o job `process` ignora.
  entregavel   boolean     not null default true
);

create unique index if not exists items_url_hash_key      on radar.items (url_hash);
create index        if not exists items_source_idx        on radar.items (source_id, coletado_em desc);
create index        if not exists items_entregaveis_idx   on radar.items (coletado_em desc) where entregavel;

-- ---------------------------------------------------------------------------
-- deliveries — um item avaliado para uma criadora, e o que aconteceu com ele
-- ---------------------------------------------------------------------------
create table if not exists radar.deliveries (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid        not null references radar.creators(id) on delete cascade,
  item_id      uuid        not null references radar.items(id)    on delete cascade,
  score        smallint    check (score between 0 and 10),
  motivo_score text,
  resumo       text,
  gancho       text,
  -- pendente  = avaliado, esperando o dispatch
  -- enviado   = foi para o WhatsApp
  -- falho     = scorer devolveu lixo, ou o envio falhou nas 3 tentativas
  -- descartado = alguma regra de ruído barrou (na calibragem, nunca acontece)
  status       text        not null default 'pendente'
                 check (status in ('pendente', 'enviado', 'falho', 'descartado')),
  erro         text,
  tentativas   smallint    not null default 0,
  -- id devolvido pela Evolution no envio; é o que liga a resposta 1/2/3 de volta
  message_id   text,
  enviado_em   timestamptz,
  feedback     smallint    check (feedback in (1, 2, 3)),
  feedback_em  timestamptz,
  created_at   timestamptz not null default now(),
  unique (creator_id, item_id)
);

create index if not exists deliveries_pendentes_idx  on radar.deliveries (created_at) where status = 'pendente';
create index if not exists deliveries_message_id_idx on radar.deliveries (message_id) where message_id is not null;
create index if not exists deliveries_enviados_idx   on radar.deliveries (creator_id, enviado_em desc) where status = 'enviado';

-- ---------------------------------------------------------------------------
-- items.embedding — reservado para dedupe semântico / cooldown de tema.
-- Não é usado por nenhum código ainda. Se a extensão `vector` não estiver
-- disponível no projeto, a coluna simplesmente não é criada e nada quebra.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector with schema extensions;
    -- 1024 = dimensão de voyage-3. Ajuste quando escolher o modelo de embedding.
    execute 'alter table radar.items add column if not exists embedding extensions.vector(1024)';
  else
    raise notice 'extensão "vector" indisponível — items.embedding não foi criada';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões. O processo usa a service_role key, que ignora RLS.
-- RLS fica ligada sem policy nenhuma para que anon/authenticated não leiam nada
-- caso o schema seja exposto na API por engano.
-- ---------------------------------------------------------------------------
grant usage on schema radar to service_role;
grant all on all tables in schema radar to service_role;
alter default privileges in schema radar grant all on tables to service_role;

alter table radar.creators       enable row level security;
alter table radar.sources        enable row level security;
alter table radar.creator_sources enable row level security;
alter table radar.items          enable row level security;
alter table radar.deliveries     enable row level security;

-- PostgREST só enxerga o schema depois de recarregar o cache.
notify pgrst, 'reload schema';
