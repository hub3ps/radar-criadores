# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# As dependências mudam menos que o código: camada separada aproveita o cache.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Reinstala só o que roda em produção — o dist já está compilado.
RUN npm ci --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime

# tzdata: sem ele o Alpine não resolve America/Sao_Paulo, e o cron, a janela de
# silêncio e o teto diário rodariam em UTC.
RUN apk add --no-cache tzdata

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Não roda como root.
USER node

EXPOSE 3000

# `node` direto, sem npm: assim o PID 1 é o Node e o SIGTERM do Easypanel chega
# no processo que sabe encerrar graciosamente.
CMD ["node", "dist/index.js"]
