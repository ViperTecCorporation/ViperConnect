FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS relay-bridge-builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY vendor/zapo-voip/native/relay-bridge/go.mod vendor/zapo-voip/native/relay-bridge/go.sum ./
RUN go mod download
COPY vendor/zapo-voip/native/relay-bridge/main.go vendor/zapo-voip/native/relay-bridge/main_test.go ./
RUN CGO_ENABLED=0 go test ./... \
    && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/relay-bridge ./main.go

FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
COPY vendor ./vendor
COPY scripts/patch-zapo-payment-info.cjs ./scripts/
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig*.json ./
COPY src ./src
COPY frontend ./frontend
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts
COPY logos ./logos
COPY lab ./lab
RUN mkdir -p /opt/mobile-registration && cp lab/registration/package*.json /opt/mobile-registration/ && cd /opt/mobile-registration && npm ci --omit=dev --ignore-scripts

FROM base AS app
COPY --from=relay-bridge-builder --chmod=0755 /out/relay-bridge /app/vendor/zapo-voip/native/relay-bridge/relay-bridge
ENV ZAPO_VOIP_RELAY_BRIDGE_PATH=/app/vendor/zapo-voip/native/relay-bridge/relay-bridge
RUN "$ZAPO_VOIP_RELAY_BRIDGE_PATH" -h
CMD ["node", "node_modules/nodemon/bin/nodemon.js", "--legacy-watch", "--watch", "dist", "--ext", "js,json", "--delay", "3", "--signal", "SIGTERM", "dist/src/cloud.js"]

FROM base AS docs
COPY docs-site/package*.json ./docs-site/
RUN cd docs-site && npm ci
COPY docs-site ./docs-site
CMD ["node", "docs-site/scripts/dev-server.mjs"]
