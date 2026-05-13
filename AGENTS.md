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
