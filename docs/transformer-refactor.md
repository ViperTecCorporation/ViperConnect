# Refatoracao segura do transformer

Este documento descreve como modularizar `src/services/transformer.ts` sem quebrar contratos existentes, imports atuais ou testes.

## Objetivo

Reduzir o tamanho e a concentracao de responsabilidades de `src/services/transformer.ts`, mantendo o mesmo comportamento externo.

A refatoracao deve ser incremental. Nao misture mudanca estrutural com feature nova ou alteracao de regra de negocio.

## Status atual

Concluido em 2026-05-04:

- `BindTemplateError` e `DecryptError` foram extraidos para `src/services/transformer/errors.ts`.
- Constantes de tipos de mensagem foram extraidas para `src/services/transformer/message_constants.ts`.
- Helpers puros de JID/telefone foram extraidos para `src/services/transformer/jid.ts`.
- `src/services/transformer.ts` continua como fachada publica, importando os modulos extraidos para uso interno e reexportando os mesmos simbolos para imports antigos.
- Teste focado executado com sucesso: `"/mnt/c/Program Files/nodejs/node.exe" node_modules/jest/bin/jest.js __tests__/services/transformer.ts --runInBand`.
- Suite completa executada com sucesso: `NODE_OPTIONS=--max-old-space-size=4096 "/mnt/c/Program Files/nodejs/node.exe" node_modules/jest/bin/jest.js --coverage`.

Concluido em 2026-05-06:

- Helpers de tipo de mensagem foram extraidos para `src/services/transformer/message_type.ts`.
- `src/services/transformer.ts` continua importando os helpers extraidos para uso interno e reexportando os mesmos simbolos para imports antigos.
- Teste focado executado com sucesso: `"/mnt/c/Program Files/nodejs/node.exe" node_modules/jest/bin/jest.js __tests__/services/transformer.ts --runInBand`.

Proximos candidatos seguros:

- Extrair helpers de grupo/direcao para `src/services/transformer/groups.ts`.
- Manter `toBaileysMessageContent` e `fromBaileysMessageContent` para uma etapa posterior.

Orientacao operacional antes da proxima refatoracao:

- Publicar primeiro a etapa ja concluida em producao.
- Observar logs reais de envio, recebimento, grupos, midia, status, edicao de mensagem e fallback de decrypt por um ciclo curto.
- So continuar a refatoracao se a producao ficar limpa, sem regressao nos contratos de webhook.
- Nao mexer em `toBaileysMessageContent` ou `fromBaileysMessageContent` antes dessa observacao em producao.
- A proxima etapa, apos validacao em producao, deve continuar pequena: mover helpers de tipo de mensagem e/ou helpers de grupo/direcao, ainda mantendo os conversores grandes no arquivo principal.

## Contrato publico

`src/services/transformer.ts` deve continuar funcionando como fachada publica enquanto houver imports existentes usando esse caminho.

Imports como este nao devem quebrar:

```ts
import {
  fromBaileysMessageContent,
  toBaileysMessageContent,
  getMessageType,
} from './transformer'
```

Quando mover funcoes para arquivos menores, reexporte pelo arquivo original:

```ts
export { fromBaileysMessageContent } from './transformer/from_baileys'
export { toBaileysMessageContent } from './transformer/to_baileys'
export { getMessageType } from './transformer/message_type'
```

## Estrutura alvo

Use nomes em `snake_case`, seguindo o padrao do repositorio.

Uma estrutura recomendada:

```text
src/services/transformer/
  index.ts
  errors.ts
  message_type.ts
  jid.ts
  groups.ts
  media.ts
  contacts.ts
  interactive.ts
  to_baileys.ts
  from_baileys.ts
  types.ts
```

Enquanto houver compatibilidade com imports antigos, mantenha:

```text
src/services/transformer.ts
```

como fachada/reexportador.

## Ordem segura de extracao

Comece por funcoes menores e mais isoladas. A ordem recomendada e:

1. Erros e constantes simples:
   - `BindTemplateError`
   - `DecryptError`
   - listas de tipos de mensagem
   - Status: concluido em `errors.ts` e `message_constants.ts`.

2. Helpers puros de JID e telefone:
   - `phoneNumberToJid`
   - `normalizeGroupId`
   - `normalizeParticipantId`
   - `toRawPnJid`
   - `jidToRawPhoneNumber`
   - `normalizeTransportJid`
   - `isIndividualJid`
   - `ensurePn`
   - `formatJid`
   - `jidToPhoneNumber`
   - `jidToPhoneNumberIfUser`
   - `normalizeUserOrGroupIdForWebhook`
   - Status: concluido em `jid.ts`.

3. Helpers de tipo de mensagem:
   - `getMessageType`
   - `getBinMessage`
   - `getNormalizedMessage`
   - `normalizeMessageContent`
   - `isSaveMedia`
   - `extractTypeMessage`
   - `isAudioMessage`
   - Status: concluido em `message_type.ts`.

4. Helpers de grupo e direcao:
   - `getGroupId`
   - `isGroupMessage`
   - `isNewsletterMessage`
   - `isIndividualMessage`
   - `isOutgoingMessage`
   - `isIncomingMessage`
   - `isUpdateMessage`
   - `extractSessionPhone`
   - `extractDestinyPhone`
   - `extractFromPhone`
   - `getChatAndNumberAndId`
   - `getNumberAndId`

5. Helpers de media/contato/interativo:
   - `getMimetype`
   - `toBuffer`
   - funcoes internas de vCard/contatos
   - funcoes internas de resposta interativa

6. Somente depois mova os conversores grandes:
   - `toBaileysMessageContent`
   - `fromBaileysMessageContent`

Esses dois conversores devem ser os ultimos, porque concentram a maior parte dos contratos com Baileys, Meta-like webhook, grupos, midia, status e mensagens interativas.

## Regras de seguranca

- Nao altere o payload de entrada ou saida durante uma refatoracao estrutural.
- Nao renomeie exports publicos no mesmo passo em que move arquivos.
- Nao altere normalizacao de grupo junto com normalizacao de usuario.
- Preserve grupos `@g.us` intactos nos payloads de webhook.
- Preserve `messages[].group_id` e `statuses[].recipient_type = 'group'` quando aplicavel.
- Preserve a conversao de usuarios para PN/LID conforme a regra existente.
- Se uma funcao usa config, Redis, Baileys, S3, logger ou defaults, trate como menos isolada e mova depois.
- Ao extrair helpers internos, prefira manter a assinatura identica.

## Testes obrigatorios

Depois de cada etapa pequena, rode ao menos o teste focado:

```sh
yarn jest __tests__/services/transformer.ts --runInBand
```

Se o ambiente Linux nao tiver `node` funcionando, use o Node do Windows ja usado neste checkout:

```sh
"/mnt/c/Program Files/nodejs/node.exe" node_modules/jest/bin/jest.js __tests__/services/transformer.ts --runInBand
```

Antes de concluir uma refatoracao maior, rode tambem:

```sh
yarn test
```

ou, neste ambiente quando necessario:

```sh
NODE_OPTIONS=--max-old-space-size=4096 "/mnt/c/Program Files/nodejs/node.exe" node_modules/jest/bin/jest.js --coverage
```

Registre na resposta final quais testes foram executados e quais nao puderam ser executados.

## Checklist antes de finalizar

- `src/services/transformer.ts` ainda exporta os mesmos simbolos usados pelo projeto.
- `__tests__/services/transformer.ts` passa.
- Imports relativos continuam validos depois da movimentacao.
- Nao houve mudanca de contrato misturada com a refatoracao.
- Comportamentos de grupo continuam preservando `@g.us`.
- Payloads Meta-like de grupo continuam mantendo `group_id` e `recipient_type`.
- O diff ficou dividido por responsabilidade, sem refatoracao ampla demais em um unico passo.
