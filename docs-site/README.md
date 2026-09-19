# ViperConnect Developers

Portal oficial separado, construído com VitePress e Scalar. O container expõe
HTTP na porta `8080`; TLS, domínio e cache externo ficam no proxy de borda.

## Atualização de rotas e contratos

Mudanças em rotas, payloads ou comportamento de integração devem acompanhar:

1. `docs/openapi.yaml`, incluindo erros, autenticação, exemplos e semântica dos campos;
2. guias web correspondentes em `guide/` e `en/guide/`;
3. um Markdown de domínio em `docs/`, junto aos documentos existentes;
4. JSON e Postman regenerados pelos scripts, com testes do contrato e validação do portal.

O contrato de eventos de sessão está em `docs/SESSION_WEBHOOKS.md` e nas páginas
`guide/session-webhooks.md` e `en/guide/session-webhooks.md`. Ele não substitui o
contrato dos webhooks de mensagens.

Na raiz do repositório, regenere com `node scripts/openapi-to-json.mjs`,
`node docs-site/scripts/sync-openapi.mjs` e `node scripts/openapi-to-postman.mjs`.
Depois valide com `node docs-site/scripts/validate-docs.mjs` e o build do portal.

## Executar o portal

```bash
npm install
npm test
npm run dev
```

Container de desenvolvimento com hot reload:

```bash
docker compose -f docs-site/compose.dev.yml up -d --build
```

O modo de desenvolvimento observa as páginas, tema, componentes, OpenAPI,
rotas e exemplos de instalação. Alterações em `docs/openapi.yaml` regeneram e
recarregam automaticamente a referência do Scalar.

Container de produção com build estático:

```bash
docker compose -f docs-site/compose.yml pull
docker compose -f docs-site/compose.yml up -d
```

O workflow `.github/workflows/docs-image.yml` valida, constrói para
`linux/amd64` e `linux/arm64` e publica no GitHub Container Registry:

```text
ghcr.io/viperteccorporation/viperconnect-docs:latest
```

Branches também recebem a própria tag, releases `vX.Y.Z` geram tags semânticas
e todo build publicado recebe `sha-<commit>`.

Para fixar uma versão em vez de acompanhar `latest`:

```bash
DOCS_TAG=4.0.19 docker compose -f docs-site/compose.yml up -d
```

Validação contra uma API:

```bash
API_BASE_URL=https://api.exemplo.com API_TOKEN=seu-token npm run test:live
```

O build sincroniza `docs/openapi.json`, adiciona rotas registradas em
`src/router.ts`, valida páginas essenciais e impede a exposição de nomes
internos na documentação pública.

## Padrão editorial

A navegação é organizada pela jornada do leitor, e não pela estrutura interna
do código:

1. **Primeiros passos**: resultado funcional em poucos minutos e modelo mental;
2. **Implantação**: escolha do ambiente e operação da infraestrutura;
3. **Mensageria**: tarefas que o integrador executa pela API;
4. **Operação**: diagnóstico, arquitetura e comportamento assíncrono;
5. **Telefonia**: domínio separado para SIP, RTP e WebRTC;
6. **Referência**: contrato exato gerado do OpenAPI.

Todo guia novo deve começar dizendo o que o leitor concluirá, declarar
pré-requisitos, usar exemplos copiáveis, mostrar o resultado esperado, explicar
falhas comuns e terminar com o próximo passo. Campos e schemas completos devem
ficar na referência interativa; guias ensinam decisões e fluxos.

Não publique contagens manuais de endpoints. A validação confere rotas, links
internos, páginas correspondentes em inglês, conteúdo essencial do quickstart e
os exemplos de implantação.

## Idiomas

Português brasileiro permanece na raiz (`/`) e inglês usa o prefixo `/en/`.
O seletor nativo do VitePress preserva a página equivalente ao trocar o
idioma. Ao adicionar um guia público à navegação, crie também o arquivo
correspondente em `docs-site/en/`; `scripts/validate-docs.mjs` verifica a
cobertura mínima dos dois idiomas. O Manager abre automaticamente `/en/` na
aba Documentação quando sua interface estiver em inglês.
