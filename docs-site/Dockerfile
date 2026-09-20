FROM node:24-alpine AS build
WORKDIR /workspace
RUN apk add --no-cache git
COPY docs-site/package*.json ./docs-site/
RUN cd docs-site && npm ci
# VitePress includes canonical Markdown from docs/ as well as the API/examples.
COPY docs ./docs
COPY scripts/openapi-to-postman.mjs ./scripts/openapi-to-postman.mjs
COPY src/router.ts ./src/router.ts
COPY logos/viperconnect_icon.svg ./docs-site/public/viperconnect_icon.svg
COPY docs-site ./docs-site
RUN cd docs-site && npm test

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/docs-site/node_modules ./node_modules
COPY --from=build /workspace/docs-site/.vitepress/dist ./dist
COPY --from=build /workspace/docs-site/serve.json ./serve.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["./node_modules/.bin/serve", "dist", "-l", "8080", "-c", "/app/serve.json"]
