FROM node:24-bookworm-slim AS builder

ENV NODE_ENV=development
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./package.json ./package.json
COPY ./yarn.lock ./yarn.lock
COPY ./vendor ./vendor
COPY ./scripts ./scripts
# Instala dependências já com o postinstall disponível
RUN corepack enable \
    && corepack use yarn@1.22.22 \
    && yarn --version \
    && yarn config set network-timeout 600000 \
    && yarn config set npmRegistryServer https://registry.npmjs.org \
    && i=0; \
       until [ "$i" -ge 3 ]; do \
         YARN_ENABLE_IMMUTABLE_INSTALLS=0 yarn install --no-progress --network-timeout 600000 && break; \
         i=$((i+1)); echo "yarn install failed ($i/3), retrying in 5s..."; \
         sleep 5; \
       done

# Garante a compilação do Baileys instalado via Git antes do build
RUN node scripts/prepare-baileys.mjs

COPY ./src ./src
COPY ./public ./public
COPY ./docs ./docs
COPY ./logos ./logos
COPY ./tsconfig.json ./tsconfig.json
RUN yarn build && yarn build:docs

FROM node:24-bookworm-slim

LABEL \
  maintainer="ViperTec Corporation <suporte@vipertec.com.br>" \
  org.opencontainers.image.title="ViperConnect" \
  org.opencontainers.image.description="ViperConnect by ViperTec Corporation, based on the original Unoapi Cloud project" \
  org.opencontainers.image.authors="ViperTec Corporation <suporte@vipertec.com.br>; Rodrigo Caitano <caitano28@gmail.com>; original Unoapi Cloud project by Clairton Rodrigo" \
  org.opencontainers.image.url="https://github.com/ViperTecCorporation/ViperConnect" \
  org.opencontainers.image.vendor="https://uno.ltd" \
  org.opencontainers.image.licenses="GPLv3"

ENV NODE_ENV=production
 
RUN groupadd -r u && useradd -r -g u u
WORKDIR /home/u/app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/logos ./logos
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/yarn.lock ./yarn.lock
COPY --from=builder /app/vendor ./vendor
COPY --from=builder /app/node_modules ./node_modules


RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg wget \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["node", "dist/src/index.js"]
