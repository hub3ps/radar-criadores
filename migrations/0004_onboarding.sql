-- Cadastro conversacional pelo WhatsApp.
--
-- Duas ideias novas: quem pode se cadastrar (convites) e onde cada conversa
-- parou (onboardings). O estado mora no banco, não em memória, porque o
-- processo reinicia a cada deploy e a conversa não pode recomeçar do zero.

-- ---------------------------------------------------------------------------
-- convites — só estes números conseguem iniciar um cadastro.
-- Sem isso, qualquer pessoa com o número da instância vira criadora ativa
-- consumindo scorer.
-- ---------------------------------------------------------------------------
create table if not exists radar.convites (
  whatsapp   text primary key,
  nome       text,
  usado_em   timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- onboardings — a conversa de cadastro em andamento.
-- ---------------------------------------------------------------------------
create table if not exists radar.onboardings (
  id            uuid primary key default gen_random_uuid(),
  whatsapp      text        not null unique,
  etapa         text        not null default 'nicho'
                  check (etapa in ('nicho','perfil','sites','instagram','tiktok','confirmacao','concluido')),
  nicho         text,
  perfil_texto  text,
  -- [{ "nome": "Deadline", "feed": "https://...", "site": "https://..." }]
  sites         jsonb       not null default '[]'::jsonb,
  -- ["handle1", "handle2"]
  instagram     jsonb       not null default '[]'::jsonb,
  tiktok        jsonb       not null default '[]'::jsonb,
  creator_id    uuid        references radar.creators(id) on delete set null,
  atualizado_em timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists onboardings_ativos_idx
  on radar.onboardings (atualizado_em desc) where etapa <> 'concluido';

grant all on all tables in schema radar to service_role;

alter table radar.convites     enable row level security;
alter table radar.onboardings  enable row level security;
