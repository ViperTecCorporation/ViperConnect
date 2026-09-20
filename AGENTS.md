# AGENTS.md

## Temporarios de validacao e Nextcloud

- A limpeza dos temporarios criados pelo agente faz parte de cada entrega, inclusive
  quando testes ou builds falham. Registre os caminhos e remova-os ao terminar.
- Prefira um diretorio unico por tarefa fora da arvore Nextcloud, no temporario
  do sistema. Evite acumular bin/Codex*, obj/Codex*, copias de build e logs grandes.
- Antes de limpar, confirme caminho, origem, conteudo descartavel, ausencia de
  arquivos versionados e de processos usando os arquivos. Prefixo codex nao basta.
- Nunca remova bin/obj inteiros, node_modules, caches compartilhados ou builds do
  usuario por rotina. Nao encerre processos do usuario para liberar arquivos.
- Preserve fontes, testes, AGENTS.md, .codex de configuracao, .github, .vscode,
  planos, evidencias solicitadas, backups, credenciais e pacotes de implantacao.
  Pastas .codex-tmp podem conter entregaveis e exigem revisao antes da remocao.
- Excluir do Nextcloud nao significa apagar. Use regras especificas por projeto
  para saidas geradas; nunca exclua bin, build, dist ou todas as pastas ocultas
  globalmente. No Chatwoot, bin contem scripts versionados, nao compilados C#.
- Mantenha dependencias e caches regeneraveis fora da sincronizacao; preserve
  dados persistentes, uploads, bancos e materiais do usuario. Nao amplie o envio
  de arquivos de autenticacao ao ajustar exclusoes.
- Informe na entrega o que foi removido, se e recuperavel e qualquer temporario
  preservado por estar em uso, ser entregavel ou ter origem incerta.


## Leitura inicial obrigatoria

Antes de mexer em `src/services/transformer.ts`, leia [docs/transformer-refactor.md](docs/transformer-refactor.md). Esse arquivo documenta a forma segura de modularizar o transformer sem quebrar imports, contratos publicos ou testes.

Antes de mexer em qualquer arquivo de `src/services/providers`, `src/services/zapo`, filas de workers ou selecao de motor por sessao, leia [docs/zapo-provider-migration.md](docs/zapo-provider-migration.md). A documentacao oficial da Zapo e os testes existentes da UnoAPI sao a fonte de verdade para essa migracao.

## Regra obrigatoria para a migracao Zapo

- Nao traduza chamadas por semelhanca de nome. Confirme assinatura, retorno e evento na documentacao ou no codigo publico oficial da Zapo.
- Todo metodo ou funcao nova deve ter caso de teste proprio. Reaproveite os testes existentes da Baileys como contrato de comportamento da UnoAPI.
- Um endpoint so pode ser marcado como suportado na Zapo depois de adapter, teste e documentacao estarem concluidos.
- Capacidade ausente deve retornar erro explicito de capability; nunca use fallback silencioso para Baileys em uma sessao configurada como Zapo.
- A migracao de credenciais Baileys para Zapo deve ser idempotente, concorrente-segura e nao deve apagar a origem. Isso permite rollback enquanto os dois motores coexistirem.
- Mantenha arquivos pequenos e separados por dominio. Nao crie um `client_zapo.ts` monolitico equivalente ao `client_baileys.ts`.

## Organizacao do projeto

Este projeto ja possui uma organizacao base por responsabilidade. Ao criar ou alterar codigo TypeScript, mantenha as novas classes dentro das camadas existentes:

- `src/controllers`: entrada HTTP. Controllers devem validar parametros, interpretar a requisicao, chamar services/jobs e devolver a resposta.
- `src/services`: regras de negocio, integracoes externas, transformacao de payloads, resolucao de IDs e contratos com Baileys/Meta/Uno.
- `src/jobs`: processamento assincrono/background. Jobs devem orquestrar execucao e chamar services.
- `src/utils`: funcoes auxiliares pequenas e preferencialmente puras, sem dependencia direta de Redis, HTTP, Baileys, S3 ou regra de negocio.
- `src/defaults.ts`: flags e configuracoes runtime.
- `src/router.ts`: registro de rotas e ligacao com controllers.
- `__tests__`: testes espelhando a area alterada, principalmente `__tests__/services` quando a regra estiver em service.

## Padrao para classes e arquivos TypeScript

- Use classes em `PascalCase`, como `GroupsController`, `ListenerBaileys` e `OutgoingJob`.
- Mantenha nomes de arquivos no padrao atual do repositorio, em `snake_case`, como `groups_controller.ts`, `listener_baileys.ts` e `contact_sync.ts`.
- Prefira colocar tipos e interfaces perto de onde sao usados.
- Se um contrato for compartilhado por mais de um arquivo, extraia para um arquivo dedicado de types, por exemplo `group_types.ts`, `message_types.ts` ou `request_types.ts`.
- Controllers nao devem concentrar regra pesada; mova regra reutilizavel para `services`.
- Services nao devem virar apenas "sacos" genericos. Quando uma area crescer, divida por dominio.

## Modularizacao incremental

O projeto esta organizado por pastas, mas alguns arquivos concentram responsabilidade demais e devem ser quebrados aos poucos quando forem tocados. Exemplos de arquivos grandes que merecem cuidado:

- `src/services/client_baileys.ts`
- `src/services/socket.ts`
- `src/services/transformer.ts`
- `src/services/redis.ts`
- `src/services/listener_baileys.ts`
- `src/controllers/groups_controller.ts`

Nao faca uma refatoracao gigante sem necessidade. Ao implementar uma feature nova ou mexer em uma area grande, prefira extrair pequenos modulos com responsabilidade clara.

Exemplo para features de grupos:

```text
src/services/groups/
  group_mapper.ts
  group_sync.ts
  group_metadata.ts
  group_types.ts
```

Exemplo para features de mensagens:

```text
src/services/messages/
  message_transformer.ts
  message_media.ts
  message_interactive.ts
  message_types.ts
```

## Regra pratica

Use este criterio antes de criar ou alterar uma classe:

- Se recebe HTTP, fica em `controllers`.
- Se decide comportamento de negocio, fica em `services`.
- Se roda em background, fica em `jobs`.
- Se e uma funcao auxiliar pequena e sem estado de negocio, fica em `utils`.
- Se e contrato compartilhado, fica em um arquivo `*_types.ts` perto do dominio.

## Telemetria Baileys WAM

A Uno habilita internamente a telemetria WAM/w:stats da Baileys para aproximar
o comportamento do WhatsApp Web. Essa configuracao fica isolada em
`src/services/baileys_connection_policy.ts`, sem ENVs publicas. O debug por
evento permanece desativado e o acompanhamento normal usa os logs resumidos
`WAM_TELEMETRY_ENABLED`, `WAM_TELEMETRY_FLUSH`, `WAM_TELEMETRY_SEND_OK` e
`WAM_TELEMETRY_SEND_ERROR`.

Quando retomar melhorias nessa area, use [docs/wam-telemetry-follow-up-plan.md](docs/wam-telemetry-follow-up-plan.md) como ponto de partida.

## Guard Baileys de envio sem TC token

A política para reduzir risco de shadow ban/erro `463` é interna e exclusiva da
Baileys. Ela fica isolada em `src/services/privacy_token_quota.ts`, sem ENVs
públicas: monitoramento ativo, bloqueio desativado, limite de 40 ocorrências em
uma janela móvel de 24 horas no Redis. A Zapo não usa esse guard.

A Uno apenas conta envios 1:1 Baileys sem `tctoken` e expõe o uso por sessão.
Não habilite bloqueio sem uma revisão explícita da política, porque alguns
contatos podem não ter token recuperável. A Baileys continua sendo a fonte de
verdade para metadata final de token quando disponível.

## Diretorio de contatos Zapo

A rota `GET /{phone}/contacts` lista o cache de contatos da sessao Zapo com paginacao por cursor. Preserve o contrato LID-first:

- `user_id` deve conter o LID canonico;
- `phone_number` deve conter somente digitos, sem sufixo JID;
- celulares brasileiros de 8 digitos devem receber o nono digito, mas telefones fixos nao podem ser alterados;
- `username` deve ser incluido como campo opcional assim que a Zapo passar a fornecer ou sincronizar esse dado no store;
- `username` complementa a identidade e nunca deve substituir `user_id` ou `phone_number`;
- toda alteracao de normalizacao, paginacao ou username exige teste de service e teste da rota HTTP.
