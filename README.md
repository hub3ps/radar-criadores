# radar-criadores

Agente que monitora fontes de notícias e perfis sociais, identifica o que é relevante
para uma criadora de conteúdo específica e manda um alerta no WhatsApp com resumo e
um ângulo de gancho para vídeo.

O valor está na velocidade: quem grava primeiro sobre a novidade sai na frente.

## Estado atual — fase de calibragem

Uma única usuária real. Nesta fase o sistema envia **todos** os itens coletados, sem
filtro de score. O score é calculado e aparece na mensagem, mas não bloqueia nada.
O objetivo é avaliar item a item e descobrir onde o corte deve ficar.

Os quatro controles de ruído (filtro de score, teto diário, janela de silêncio,
cooldown de tema) estão implementados e testados, porém **desligados por `.env`**.
Quando a validação terminar, ligar é questão de trocar `false` por `true`.

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 22 + TypeScript 7 (ESM, `nodenext`) |
| Banco | Supabase / Postgres, schema `radar`, via `@supabase/supabase-js` |
| Agendamento | `node-cron` dentro do próprio processo |
| LLM | OpenRouter (API compatível com a da OpenAI), via `fetch` |
| WhatsApp | Evolution API (envio + webhook de resposta) |
| Social | Apify via REST, atrás de uma interface `SocialProvider` |
| HTTP | `node:http` da stdlib — sem Express |
| Testes | `node:test` da stdlib — sem framework |
| Deploy | Docker (processo contínuo) no Easypanel, numa VPS Linux |

Sem framework de mais: nada de NestJS, nada de ORM. As únicas dependências de runtime
são o cliente do Supabase, `node-cron`, `rss-parser`, `zod` e `dotenv`.

## Arquitetura

Um único processo Node faz tudo:

```
                    ┌──────────────── processo único ────────────────┐
  RSS  ─┐           │                                                │
  IG   ─┼─ collect ─┼─→ radar.items ─→ process ─→ radar.deliveries ──┼─→ dispatch ─→ WhatsApp
  TikTok┘  (cron)   │   (dedupe por     (cron)     (enviado_em NULL)  │    (cron)
                    │    url_hash)      + scorer                      │
                    │                                                │
                    │   node:http  ──→  GET /health                  │
                    │             └──→  POST /webhook/evolution ──→ radar.deliveries.feedback
                    └────────────────────────────────────────────────┘
```

Três jobs desacoplados pelo banco. Cada um pode falhar e ser repetido sem estragar
o anterior — `collect` não sabe que `dispatch` existe.

```
src/
  collectors/
    types.ts        # interface Collector, tipo RawItem normalizado
    rss.ts
    instagram.ts    # = criarColetorSocial('instagram', apifyProvider)
    tiktok.ts       # = criarColetorSocial('tiktok', apifyProvider)
    index.ts        # registro de coletores por tipo de fonte
    descoberta.ts   # acha o RSS de um site a partir do domínio
    social/
      provider.ts   # interface SocialProvider
      apify.ts      # implementação Apify (REST), com dry-run
      base.ts       # coletor social genérico, compartilhado pelas duas redes
  core/
    openrouter.ts   # chamada ao modelo com JSON validado
    dedupe.ts       # url canônica + url_hash
    scorer.ts       # 1 chamada por item via OpenRouter, JSON estrito
    formatter.ts    # monta a mensagem do WhatsApp
    regras.ts       # os 4 controles de ruído (existem, desligados)
  delivery/
    whatsapp.ts     # envio via Evolution API v2
    inbound.ts      # webhook: roteia entre cadastro e feedback
    onboarding.ts   # cadastro conversacional (roteiro fixo, estado no banco)
  db/
    supabase.ts
    types.ts        # tipos das tabelas do schema radar
  jobs/
    collect.ts
    process.ts
    dispatch.ts
  testing/          # só para dev e testes — fica fora do build
    env.ts          # .env mínimo para os testes
    rss-check.ts    # inspeciona um feed sem banco e sem gastar scorer
  config.ts         # lê e valida o .env (zod), falha rápido no boot
  logger.ts         # log estruturado em stdout
  server.ts         # node:http — /health e /webhook/evolution
  cli.ts            # roda um job avulso, fora do cron
  index.ts          # boot: config → server → cron → shutdown gracioso
migrations/
  0001_schema_radar.sql
  0002_seed_exemplo.sql
  0003_feedback_idempotente.sql
  0004_onboarding.sql
```

## Cadastro pelo WhatsApp

Uma criadora nova se cadastra conversando. O fluxo é um roteiro fixo de seis
perguntas — nicho e público, o que a faz gravar, o que ela nunca cobriria, sites,
Instagram, TikTok — e o modelo entra só para interpretar a resposta livre dela
(achar handles e domínios no meio do texto), nunca para conduzir a conversa.

**"O que te faz gravar" e "o que você nunca cobriria" são perguntas separadas de
propósito.** Na primeira versão elas vinham juntas com "para quem você fala", e a
primeira criadora respondeu só o público — a sub-pergunta mais fácil. O perfil
resultante descrevia a audiência e não a cobertura, e o scorer ficou sem o que
mais discrimina: a lista do que ela não quer. Uma pergunta, um assunto. O estado mora em `radar.onboardings`,
porque o processo reinicia a cada deploy e a conversa não pode recomeçar do zero.

**Só quem está em `radar.convites` consegue se cadastrar.** Sem essa lista,
qualquer número com o contato da instância viraria criadora ativa consumindo
scorer. Para liberar alguém:

```sql
insert into radar.convites (whatsapp, nome) values ('5547999999999', 'Morgana');
```

O teto de fontes por tipo é `CADASTRO_MAX_FONTES` — as perguntas se ajustam ao
valor, então subir o limite não exige mexer em texto nenhum.

Quando ela indica um site, o `descoberta.ts` procura o feed: testa se a própria
URL já é RSS, lê o `<link rel="alternate">` da home, e tenta os caminhos
convencionais. Se o site não publicar RSS — o AdoroCinema, por exemplo, não
publica — o agente avisa e pede outro, em vez de cadastrar uma fonte morta.

No `inbound`, **cadastro tem precedência sobre feedback**: dentro da conversa um
`1` é resposta a uma pergunta, não nota de um item.

Todo collector implementa a mesma interface e devolve `RawItem[]` normalizado
(`url`, `titulo`, `texto`, `autor`, `publicado_em`, `source_id`). Isso permite trocar o
fornecedor de scraping de Instagram/TikTok sem tocar no resto do código: actors da Apify
são mantidos por terceiros e quebram quando a plataforma muda o anti-bot. Trocar de
fornecedor precisa custar um arquivo, não um refactor — por isso o nome do actor vem do
`.env`, nunca hardcoded.

## Setup local

Requisitos: Node.js 22+ e um projeto Supabase.

```bash
npm install
cp .env.example .env      # preencha os valores
```

Aplique as migrações no Supabase (SQL Editor, ou psql):

```bash
psql "$SUPABASE_DB_URL" -f migrations/0001_schema_radar.sql
# edite os valores antes de rodar o seed
psql "$SUPABASE_DB_URL" -f migrations/0002_seed_exemplo.sql
```

**Depois disso, vá em Settings → API → Exposed schemas e adicione `radar`.** Sem isso o
PostgREST devolve 404 em toda query e o processo sobe sem conseguir ler nada.

O `0002_seed_exemplo.sql` é um modelo: uma criadora e quatro fontes. O `perfil_texto` é
o insumo principal do scorer — é ele que decide se um item vale 9 ou 3 para *esta*
pessoa. Diga o que ela cobre, para quem ela fala, que formato de vídeo faz e,
principalmente, o que ela **não** cobre.

Antes de cadastrar um feed novo, dá para ver o que o coletor extrai dele sem tocar no
banco nem gastar nada com o scorer:

```bash
npx tsx src/testing/rss-check.ts https://exemplo.com/feed
```

Rodar:

```bash
npm run dev            # processo completo com watch
npm run typecheck
npm test               # node:test, sem framework
npm run build && npm start
```

Rodar um job avulso, sem esperar o cron (útil para depurar):

```bash
npm run job -- collect          # rss + social
npm run job -- collect:rss
npm run job -- collect:social
npm run job -- process
npm run job -- dispatch
```

## Variáveis de ambiente

### Supabase
| Variável | Padrão | Descrição |
|---|---|---|
| `SUPABASE_URL` | — | URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role. O processo é backend e escreve em todas as tabelas |
| `SUPABASE_SCHEMA` | `radar` | Schema usado pelo cliente |

### OpenRouter (scorer)
| Variável | Padrão | Descrição |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Chave da API |
| `OPENROUTER_MODEL` | `anthropic/claude-opus-5` | Formato `fornecedor/modelo` |
| `OPENROUTER_MODELO_TRIAGEM` | `anthropic/claude-haiku-4.5` | Modelo barato da triagem |
| `TRIAGEM_ATIVA` | `false` | Liga a triagem antes do scorer |
| `TRIAGEM_CORTE` | `4` | Abaixo disto o item nem chega ao modelo caro |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Trocar só para apontar noutro gateway |
| `OPENROUTER_REASONING_EFFORT` | `none` | `none` / `low` / `medium` / `high` |

A API do OpenRouter é compatível com a da **OpenAI**, não com a da Anthropic — por
isso o modelo vai como `anthropic/claude-opus-5` e o scorer fala HTTP direto, sem SDK.
O pedido usa `response_format: json_schema` com `strict`; se o endpoint roteado não
suportar, o scorer repete sem o schema e cai no parse defensivo.

### Evolution API
| Variável | Padrão | Descrição |
|---|---|---|
| `EVOLUTION_BASE_URL` | — | Ex.: `https://evo.seudominio.com` |
| `EVOLUTION_INSTANCE` | — | Nome da instância conectada |
| `EVOLUTION_API_KEY` | — | Vai no header `apikey` |
| `EVOLUTION_WEBHOOK_TOKEN` | — | Segredo verificado no `POST /webhook/evolution` |

### Apify (Instagram e TikTok)
| Variável | Padrão | Descrição |
|---|---|---|
| `APIFY_TOKEN` | — | Sem token, o coletor loga aviso e devolve vazio — não derruba o processo |
| `APIFY_ACTOR_INSTAGRAM` | `apify/instagram-scraper` | ~US$ 1,50 / 1.000 posts, cobrança por resultado |
| `APIFY_ACTOR_TIKTOK` | `scraptik/tiktok-api` | ~US$ 0,002 / requisição, independente do nº de resultados |
| `SOCIAL_DRY_RUN` | `true` | Loga o que seria raspado, sem chamar a Apify nem gastar crédito |

### Cadência
| Variável | Padrão | Descrição |
|---|---|---|
| `RSS_INTERVALO_MIN` | `5` | Coleta de RSS |
| `SOCIAL_INTERVALO_MIN` | `60` | Coleta social. 1h é decisão de custo, não limitação técnica |
| `SOCIAL_POSTS_POR_PERFIL` | `3` | Teto de posts puxados por perfil, por rodada |
| `DISPATCH_INTERVALO_MIN` | `2` | Varredura de deliveries pendentes |

### Controles de ruído — todos desligados na calibragem
| Variável | Padrão | Descrição |
|---|---|---|
| `FILTRO_SCORE_ATIVO` | `false` | Quando `true`, descarta item abaixo de `creators.corte_score` |
| `TETO_DIARIO_ATIVO` | `false` | Quando `true`, respeita `creators.teto_dia` (0 = ilimitado) |
| `JANELA_SILENCIO_ATIVA` | `false` | Quando `true`, segura envio dentro da janela da criadora |
| `COOLDOWN_TEMA_ATIVO` | `false` | Quando `true`, evita repetir tema muito parecido |
| `COOLDOWN_TEMA_HORAS` | `12` | Janela do cooldown de tema |

### Runtime
| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Servidor HTTP (health + webhook) |
| `TZ` | `America/Sao_Paulo` | Base do cron, da janela de silêncio e do teto diário |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `BACKFILL_PRIMEIRA_COLETA` | `false` | Na 1ª coleta de uma fonte nova, marca o histórico como visto sem entregar |

## Triagem: por que existem dois modelos

O filtro de score roda no `dispatch`, **depois** do scorer — e não pode ser
diferente, porque para saber se a nota passa do corte é preciso primeiro gerá-la.
Medido em produção: 89% dos itens pontuados nunca chegavam à criadora, mas eram
pagos igual, a ~US$ 0,035 cada.

A triagem resolve isso sem tocar na qualidade do que ela recebe. Um modelo barato
dá **só uma nota**, com o texto truncado em 1.500 caracteres; quem passa vai para
o modelo caro, que escreve resumo e gancho como sempre.

O corte da triagem fica folgadamente abaixo do corte de envio, e a razão é
assimétrica: errar para cima custa uma chamada a mais ao modelo caro; errar para
baixo mata uma novidade boa em silêncio. Por isso, também, **falha de triagem
deixa o item passar** em vez de descartá-lo.

Validado contra 154 itens reais já pontuados pelo modelo caro: nenhum item bom
(nota >= 6) recebeu triagem abaixo de **7**, contra um corte de 4. Nenhuma perda
em corte algum de 1 a 5, com 77% de economia no corte escolhido.
`src/testing/triagem-validar.ts` refaz essa medição quando o perfil mudar.

Quem não passa vira delivery `descartado` com a nota da triagem — precisa virar
linha no banco, senão o item seria triado de novo a cada rodada.

## Quão recente é o que ela recebe

Quatro camadas, e elas medem coisas diferentes:

| Camada | Mede | Efeito |
|---|---|---|
| Backfill por fonte | primeira coleta | o histórico do feed nunca é entregue |
| Corte por criadora | `coletado_em` vs cadastro dela | ela só recebe o que chegou depois de entrar |
| `ITEM_VALIDADE_HORAS` | `coletado_em` | teto de quanto tempo um item fica na fila |
| `ITEM_IDADE_MAX_HORAS` | `publicado_em` | teto da idade real da notícia |

As três primeiras medem quando **nós** vimos o item. Só a última olha a data da
fonte — e é ela que protege o caso em que o processo fica fora do ar e volta:
ao voltar, ele coleta o feed inteiro, tudo parece novo, e sem esse filtro uma
matéria de três dias chegaria como se fosse deste minuto.

Quando o feed não informa `publicado_em` (parte das redes sociais não informa),
a data de coleta é usada como melhor palpite disponível.

## Formato da mensagem

```
[8] Título da novidade
Nome da Fonte · há 12 min

Duas ou três linhas com os pontos mais interessantes do item,
o suficiente pra decidir se vale gravar.

Gancho: o ângulo de abertura sugerido, em uma frase.

https://exemplo.com/materia

Responde: 1 = gravaria · 2 = talvez · 3 = lixo
```

A resposta `1`, `2` ou `3` cai no webhook e vira `radar.deliveries.feedback`. O vínculo é
feito pelo `message_id` que a Evolution devolve no envio e que guardamos junto do delivery.
Quando a resposta não é citada (ela só digita `1`), o fallback atribui à última mensagem
enviada para aquele número nas últimas 6 horas.

Configure o webhook na Evolution apontando para:

```
POST https://seu-radar.easypanel.host/webhook/evolution/<EVOLUTION_WEBHOOK_TOKEN>
```

Basta o evento `messages.upsert`. O endpoint responde 200 mesmo quando ignora a mensagem
— reenfileirar um webhook não conserta uma falha nossa, e o erro fica no log.

## Deploy (Easypanel)

Serviço único de processo contínuo em Docker. Nada de serverless: o Vercel Hobby foi
descartado porque o cron é limitado a uma execução diária e o plano não permite uso comercial.

- `Dockerfile` multi-stage: build do TypeScript, imagem final `node:22-alpine` só com
  dependências de produção
- Um único processo Node — `node-cron` cuida de collect/process/dispatch e o `node:http`
  expõe o webhook da Evolution
- Healthcheck do Easypanel em `GET /health` (200)
- `docker-compose.yml` para rodar local
- Encerramento gracioso em `SIGTERM`: para de aceitar novas rodadas, termina o job em
  andamento e só então sai
- Logs estruturados em stdout, um JSON por linha

No Easypanel: criar um app a partir do repositório, apontar o healthcheck para `/health`,
colar as variáveis de ambiente e expor a porta `3000` para o domínio que a Evolution vai
chamar no webhook.

## Próximos passos

### Catálogo de fontes por nicho — adiado

Hoje o cadastro pergunta à criadora quais sites ela quer acompanhar. A pergunta é
mal endereçada: ela sabe o que quer, mas não tem como saber quais sites publicam
RSS. Foi o que aconteceu no primeiro teste — indicou o AdoroCinema, que não tem
feed, e do ponto de vista dela o produto falhou numa responsabilidade nossa.

A ideia é um catálogo curado que o agente oferece a partir do que ela descreveu.

**Adiado até depois do primeiro cadastro real.** O catálogo é curado uma vez e
serve todas as criadoras daquele nicho — com uma única criadora, o custo de
curadoria não se paga. E o teste vai mostrar se a pergunta de sites é mesmo
atrito na prática.

Quando for construir, **não** usar tabela `nicho → fonte`. `creators.nicho` é
texto livre ("Inteligência artificial", "IA", "tech") e casamento literal quase
nunca acerta; manter sinônimos vira trabalho permanente. E a relação é nebulosa:
o Deadline serve cinema, séries, streaming e parcialmente negócios de mídia.

A forma que vale a pena:

```
fontes_catalogo
  feed, nome, site, idioma
  cobre          -- descrição em texto do que a fonte publica
  volume_dia     -- itens/dia, medido e não estimado
  verificado_em
```

- o casamento acontece contra o **`perfil_texto`**, não contra o nicho. O perfil
  já é coletado antes da pergunta de sites e é o insumo mais rico que existe —
  é o mesmo que faz o scorer acertar
- na etapa de sites o modelo escolhe 3-5 candidatas e o agente as oferece
  numeradas; ela responde os números e ainda pode acrescentar sites próprios,
  então o fluxo atual continua valendo como caminho alternativo
- quais fontes entram é julgamento editorial de quem opera; verificar o feed e
  medir o volume é automático
- feed morre: prever um job que revalide o catálogo e marque as quebradas

### Cadastro sem digitar — adiado

A primeira criadora pediu que o cadastro não exija digitação. Existe uma tensão
real: é digitando que sai a informação que faz o produto funcionar. A resposta
"o que você nunca cobriria" foi o que derrubou o ruído de nota 3 para 0-2, e o
primeiro perfil dela, que só descrevia a audiência, gerava nota média para tudo.

Então: tirar a digitação de onde ela é chata, não de onde ela é útil.

- **manter** como texto livre: nicho/público, "o que te faz gravar", "o que você
  nunca cobriria" — as três que alimentam o `perfil_texto`
- **tirar** das fontes: lista numerada em vez de "quais sites você quer?". É o
  catálogo acima por outro ângulo; as duas devem ser construídas juntas
- **acrescentar** o @ da própria criadora. Hoje a voz dela foi extraída na mão
  dos posts com `src/testing/perfil-do-criador.ts`; devia sair no cadastro

A voz importa mais do que parecia. A criadora apontou que, se ela e outra
receberem a mesma matéria com o mesmo gancho, abrem o vídeo igual — é a voz de
cada uma no perfil que separa os dois.

### Outras pendências

- Substituir o `perfil_texto` rascunhado pelo Claude por um escrito pela criadora
- Rotacionar a `AUTHENTICATION_API_KEY` da Evolution e a senha do Postgres em
  `DATABASE_CONNECTION_URI`
- Com ~40 respostas de feedback, cruzar score contra feedback para achar o corte

## O que já existe

- [x] `package.json` e toolchain (TS 7, `nodenext`, `node:test` — zero dependência de teste)
- [x] Migração SQL do schema `radar` + seed de exemplo
- [x] Estrutura completa de pastas, tipos e interfaces
- [x] Coletor RSS de ponta a ponta (feed → corpo do artigo → dedupe → `items`)
- [x] Scorer via OpenRouter (json_schema estrito, fallback sem schema, parse defensivo)
- [x] Envio via Evolution API v2 + webhook de feedback
- [x] Coletores de Instagram e TikTok atrás de `SocialProvider`, com dry-run
- [x] Os 4 controles de ruído implementados e testados, desligados por `.env`
- [x] Dockerfile, `docker-compose.yml`, `/health` e encerramento gracioso
- [x] 75 testes cobrindo regras, dedupe, formatter, webhook, extração de HTML e cron

### O que ainda não foi exercitado contra o serviço real

O que depende de credencial que ainda não existe aqui foi escrito e tipado, mas nunca
rodou contra o serviço de verdade:

- a chamada ao modelo no `scorer` (sem `OPENROUTER_API_KEY` nesta máquina)
- o envio pela Evolution e o webhook de volta (sem instância conectada)
- as queries no Supabase (sem projeto)
- os actors da Apify (`SOCIAL_DRY_RUN=true` por padrão)

O caminho para validar cada um, em ordem: aplique as migrações, exponha o schema,
rode `npm run job -- collect:rss` e confira a tabela `items`; depois
`npm run job -- process` e confira `deliveries`; depois `npm run job -- dispatch`.

### Decisões que valem revisar depois da calibragem

- **Modelo do scorer**: está em `anthropic/claude-opus-5` (US$ 5/M entrada, US$ 25/M saída
  no OpenRouter), ~US$ 0,014 por item. A ~100 itens/dia dá ~US$ 40/mês, mais a margem do
  OpenRouter. Se o volume subir, `anthropic/claude-sonnet-5` corta para cerca de um terço —
  mas na calibragem a qualidade da nota é justamente o que se mede.
- **`OPENROUTER_REASONING_EFFORT`** está em `none` para reduzir o que pode dar errado no
  primeiro dia. Se as notas vierem rasas ou pouco discriminantes, suba para `low`/`medium`.
- **`items.embedding`** existe na tabela e não é usada por nada. É o caminho para trocar
  o cooldown de tema (hoje Jaccard sobre o título) por similaridade semântica.
- **Fallback do feedback**: sem `stanzaId`, a resposta `1`/`2`/`3` é atribuída à última
  mensagem enviada nas últimas 6 horas. Se ela responder fora de ordem, o feedback vai
  para o item errado. Se isso acontecer na prática, o jeito é forçar resposta citada.
