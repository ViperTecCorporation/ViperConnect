FROM node:24-bookworm-slim

# Install dependencies including CA certificates, curl and wget, then fetch wait-for
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ffmpeg curl wget ca-certificates python3 make g++ \
    && update-ca-certificates \
    && curl -fsSL -o /usr/local/bin/wait-for https://raw.githubusercontent.com/eficode/wait-for/v2.2.3/wait-for \
    && chmod +x /usr/local/bin/wait-for \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./package.json ./package.json
COPY ./tsconfig.json ./tsconfig.json
COPY ./nodemon.json ./nodemon.json
COPY ./yarn.lock ./yarn.lock
COPY ./vendor ./vendor
COPY ./public ./public
COPY ./docs ./docs
COPY ./scripts ./scripts
COPY ./logos ./logos
COPY ./src ./src

RUN corepack enable && corepack use yarn@1.22.22 && yarn --version && YARN_ENABLE_IMMUTABLE_INSTALLS=0 yarn install --no-progress && yarn build:docs
