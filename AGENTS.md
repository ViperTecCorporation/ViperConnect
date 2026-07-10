# AGENTS.md

## Leitura inicial obrigatoria

Antes de mexer em `src/services/transformer.ts`, leia [docs/transformer-refactor.md](docs/transformer-refactor.md). Esse arquivo documenta a forma segura de modularizar o transformer sem quebrar imports, contratos publicos ou testes.

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

A Uno habilita a telemetria WAM/w:stats da Baileys por padrao para aproximar o comportamento do WhatsApp Web:

- `BAILEYS_WAM_TELEMETRY=true`
- `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=false`
- `BAILEYS_WAM_TELEMETRY_FLUSH_MS=5000`
- `BAILEYS_WAM_TELEMETRY_MAX_EVENTS=50`

Mantenha `BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS=false` em producao salvo durante investigacao pontual. Com `true`, cada evento individual gera `WAM_TELEMETRY_COMMIT` e o log fica volumoso. O acompanhamento normal deve usar os logs resumidos `WAM_TELEMETRY_ENABLED`, `WAM_TELEMETRY_FLUSH`, `WAM_TELEMETRY_SEND_OK` e `WAM_TELEMETRY_SEND_ERROR`.

Quando retomar melhorias nessa area, use [docs/wam-telemetry-follow-up-plan.md](docs/wam-telemetry-follow-up-plan.md) como ponto de partida.

## Guard de envio sem TC token

A Uno aplica uma politica por sessao para reduzir risco de shadow ban/erro `463`: envios 1:1 sem `tctoken` entram em uma janela movel no Redis. Por padrao:

- `UNOAPI_MISSING_TC_TOKEN_GUARD_ENABLED=true`
- `UNOAPI_MISSING_TC_TOKEN_BLOCK_ENABLED=false`
- `UNOAPI_MISSING_TC_TOKEN_LIMIT=40`
- `UNOAPI_MISSING_TC_TOKEN_WINDOW_HOURS=24`

Por padrao, a Uno apenas conta envios 1:1 sem `tctoken` e expoe o uso por sessao. Ela nao deve bloquear o envio enquanto `UNOAPI_MISSING_TC_TOKEN_BLOCK_ENABLED=false`, porque alguns contatos podem nao ter token recuperavel. Se a env de bloqueio estiver `true` e o limite for atingido, antes de bloquear a Uno tenta recuperar `tctoken` no servidor via Baileys; se recuperar, envia normalmente. Se continuar sem `tctoken`, bloqueia antes de chamar o envio real, retorna status `failed` e emite webhook auxiliar para a aplicacao e para a propria sessao com o resumo da mensagem original. A Baileys deve continuar sendo a fonte de verdade para metadata final de token quando disponivel.
