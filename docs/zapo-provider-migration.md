# Migracao incremental Baileys -> Zapo

## Objetivo

Adicionar a Zapo como segundo motor do ViperConnect sem alterar o contrato HTTP da UnoAPI. A escolha e feita por sessao, com Baileys como padrao. Ao selecionar Zapo, credenciais existentes da Baileys devem ser migradas automaticamente, sem apagar a origem. Quando a matriz Zapo atingir 100% dos recursos usados pelo produto, a Baileys podera ser removida.

## Fontes de verdade

1. Contratos e casos de teste existentes em `__tests__`.
2. Documentacao oficial: <https://zapo.to/pt-br>.
3. Repositorio oficial: <https://github.com/vinikjkkj/zapo>.
4. Guia oficial de migracao: <https://zapo.to/pt-br/guides/migrating-from-baileys>.

Nao usar forks homonimos nem inferir uma chamada apenas pelo nome. Registrar no teste a assinatura efetivamente usada.

## Arquitetura alvo

```text
HTTP/API Cloud
  -> resolve configuracao da sessao
  -> publica em fila.<servidor>.<motor>
       -> worker Baileys
       -> worker Zapo
  <- eventos normalizados pelo contrato UnoAPI
```

O container web nao abre socket do WhatsApp. Cada worker executa somente um motor, definido por `UNOAPI_WORKER_ENGINE=baileys|zapo`. As filas de `bind`, `reload`, `logout` e `incoming` precisam conter servidor e motor. Sem essa separacao, consumidores concorrentes podem retirar e descartar tarefas do outro motor.

Configuracao:

- `provider` por sessao: `baileys`, `zapo` ou `forwarder`.
- `WHATSAPP_ENGINE`: padrao para sessoes sem valor persistido; default `baileys`.
- `UNOAPI_WORKER_ENGINE`: motor exclusivo do processo worker.
- `UNOAPI_PROCESS_ROLE`: papel do entrypoint cloud (`web`, `broker`, `worker` ou `all` legado).
- `forwarder` continua no worker legado enquanto existir.

## Limites entre camadas

```text
src/services/providers/
  provider_types.ts       tipos e capabilities
  provider_resolver.ts    escolha do motor
  provider_queue.ts       nomes de filas isoladas
  client_factory.ts       instancia o adapter correto
  listener_router.ts      separa o pipeline de eventos por motor

src/services/zapo/
  zapo_store.ts           Redis/SQLite e lifecycle
  zapo_store_registry.ts  backend unico por processo
  zapo_migration.ts       coordenacao idempotente
  baileys_snapshot.ts     somente leitura da origem
  zapo_snapshot.ts        gravacao no destino
  zapo_messages.ts        envio e operacoes de mensagem
  zapo_groups.ts          grupos e participantes
  zapo_events.ts          eventos para modelo canonico
  zapo_identity.ts        PN/LID e normalizacao na borda
  zapo_username_index.ts  alias temporal username -> LID aprendido por evento

src/services/client_zapo.ts
  fachada fina: conexao, eventos e delegacao aos modulos Zapo
```

Controllers nao conhecem Baileys nem Zapo. Jobs orquestram. Adapters traduzem. Funcoes puras de mapeamento ficam pequenas e recebem todos os dados por parametro.

## Transformer

O `src/services/transformer.ts` continua como fachada publica. Antes de altera-lo, ler `docs/transformer-refactor.md`.

A refatoracao deve ser incremental:

1. Extrair um modelo canonico UnoAPI independente do provider.
2. Manter mappers Baileys -> canonico em modulos pequenos.
3. Criar mappers Zapo -> canonico equivalentes.
4. Manter exports e assinaturas publicas existentes.
5. Executar os testes do transformer apos cada extracao.

Nao fazer uma reescrita completa do transformer junto com a integracao.

## Migracao automatica de sessao

Fluxo obrigatorio ao iniciar uma sessao Zapo:

1. Adquirir a lease Redis `unoapi-lease:zapo-session:<telefone>`. Ela cobre migracao e socket; somente o dono pode continuar. Em SQLite, manter um unico processo Zapo.
2. Verificar se o destino Zapo ja possui credenciais validas; se sim, nao migrar.
3. Ler snapshot Baileys de Redis ou arquivos sem modifica-lo.
4. Se nao houver credencial Baileys, seguir para pareamento novo da Zapo.
5. Converter com `wa-store-migrate`, seguindo o guia oficial.
6. Gravar os dominios Zapo e validar leitura das credenciais.
7. Registrar resultado, perdas declaradas e versoes das bibliotecas.
8. Manter a lease renovada durante a conexao e libera-la ao desconectar. Falha de renovacao derruba o socket de forma conservadora.

Os containers Baileys e Zapo podem coexistir. Para escalar replicas Zapo, preserve o roteamento por `server`/motor; a lease impede socket duplicado, mas nao substitui afinidade das filas por sessao.

Falha de migracao nao autoriza fallback silencioso. A sessao permanece Zapo, informa erro claro e preserva integralmente a origem Baileys.

## Politica de testes

Cada funcao nova tem pelo menos um teste dedicado. Funcoes com decisao, erro ou idempotencia exigem um caso por ramo relevante.

Para cada endpoint dependente do WhatsApp:

1. Manter o caso de teste atual como contrato comum.
2. Rodar o mesmo contrato contra o adapter Baileys.
3. Rodar o mesmo contrato contra o adapter Zapo.
4. Adicionar teste de capability ausente quando a Zapo nao oferecer equivalente.
5. So marcar o endpoint como concluido depois de teste unitario, teste de integracao fake e build.

Suites minimas por etapa:

```bash
yarn test --runInBand __tests__/services/provider_resolver.ts
yarn test --runInBand __tests__/services/provider_queue.ts
yarn test --runInBand __tests__/services/transformer.ts
yarn test --runInBand __tests__/services/incoming_amqp.ts
yarn test --runInBand __tests__/routes/messages.ts __tests__/routes/groups.ts
yarn build
```

Ao final, executar a suite completa. Nao reduzir cobertura, nao remover teste Baileys para fazer a Zapo passar e nao mockar o proprio mapper sob teste.

## Matriz de entrega

Estados permitidos: `nao iniciado`, `adapter`, `testado`, `documentado`, `concluido`, `sem capability`.

| Dominio | Contrato UnoAPI | Zapo oficial | Estado inicial |
|---|---|---|---|
| Sessao | connect, QR, pairing, reconnect, logout | auth/connection | testado |
| Mensagens | texto, midia, contato, interativo, raw e reacao | `client.message` | testado |
| Operacoes | responder, editar, apagar e recibos | `client.message` | testado |
| Midia | upload, download e decriptacao | message/media + media-utils | testado |
| Grupos | listar/cache, criar, metadata, alterar e sair | `client.group` | testado |
| Participantes | add/remove/promote/demote/aprovacoes | `client.group` | testado |
| Presenca | online/offline, composing, recording e paused | `client.presence` | testado |
| Contatos/perfil | verificacao de numeros e foto de grupo | profile/privacy | testado |
| Historico | sync inicial e sob demanda | history sync | testado |
| Eventos | message, receipt, addon, connection, group e username | event map/MEX | testado |
| Privacy token | consulta, bootstrap e cache | privacy token | testado |
| Passkey | bridge WebAuthn externo | `signPasskeyAssertion` | testado |
| Coexistencia | fluxo Meta especifico atual | sem coordinator equivalente documentado | sem capability |
| Chamadas | receber e rejeitar automaticamente | `@zapo-js/voip`, `client.voip.rejectCall` | testado |
| Status | publicar e receber `status@broadcast` | `client.status` e evento message | testado |
| Recuperacao | reenviar preservando ID publico | `message.send({ id })` e retry interno | testado |
| Newsletter/broadcast list | rotas e eventos atuais | coordinators dedicados | nao iniciado |

`sem capability` e uma limitacao explicita, sem fallback silencioso para Baileys. O fluxo manual de passkey continua fora do adapter. Newsletter e listas de transmissao devem permanecer desabilitadas para sessoes Zapo ate ganharem adapter e testes de contrato.

Manter esta tabela atualizada no mesmo commit que muda o estado de uma capacidade.

## Username

A identidade canonica Zapo e o LID. `senderUsername`, participantes de grupo e eventos
MEX alimentam um indice temporal `username -> LID`. A API aceita envio/consulta por
`@username` quando esse alias ja foi aprendido. A documentacao oficial oferece consulta
LID -> username, mas nao username -> LID; portanto alias desconhecido retorna erro claro
e nunca e convertido por heuristica em telefone.

## Auditoria completa

O resultado classe a classe e mantido em `docs/zapo-class-audit.md`.

## Criterio para retirar Baileys

A Baileys somente pode ser removida quando:

- todas as sessoes ativas tiverem migrado ou pareado na Zapo;
- todos os dominios usados estiverem `concluido` ou houver decisao de produto documentada para remover o recurso;
- testes de contrato Zapo cobrirem todos os endpoints dependentes do WhatsApp;
- nao houver fallback Baileys em producao por um ciclo de observacao definido;
- rollback de dados tiver sido validado antes da remocao final.
