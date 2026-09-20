# Inventário administrativo executável

Auditoria local de 20/09/2026. Fontes: `src/router.ts`, o subrouter em `src/controllers/manager_controller.ts`, controllers administrativos, `frontend/core/api.ts`, `frontend/app.ts` e as rotas em `../unoapi-voip-service/src/routes/console/`. Nenhuma operação HTTP foi executada; não houve alteração de produção.

## Lacunas encontradas e corrigidas

| Lacuna | Correção |
| --- | --- |
| Redis e RabbitMQ excluídos do OpenAPI interativo pelo sincronizador e ignorados pelo validador | Removida a exclusão; categoria Administração, autenticação e avisos de efeitos reais |
| `GET /admin/redis/tree` e `DELETE /admin/redis/tree` ausentes do contrato-fonte | Parâmetros prefix/limit, resposta de nós, confirmação literal, resultado da exclusão e exemplos |
| `GET /admin/voip/console/bootstrap` ausente | Contratos administrativo e restrito, capacidades e exemplo |
| `PUT /admin/voip/console/extensions/{extensionId}/sip-mode` ausente | Corpo estrito sipEndpointMode: extension/trunk; administrador ou usuário padrão somente para zapo_auto próprio não compartilhado; retorno extensionId/sipEndpointMode |
| CRUD VoIP apenas em `{resource}` | Entradas concretas GET de coleção e PUT/DELETE por ID para companies, accounts, sessions, extensions, lineGroups e extensionGroups |
| Credenciais SIP descritas apenas como administrativas | GET específico admite ramal automático próprio não compartilhado, com ID/vínculo comprovados e resposta restrita |
| Remoção de registros sem limite secundário explícito | DELETE continua administrativo; disconnectRegistration=false e motivo do bloqueio documentados |
| Postman herdava Bearer até no login e upload binário era corpo textual | Login noauth, variáveis por classe de credencial e seleção manual de arquivo |
| Respostas administrativas pouco visíveis no Postman | Exemplos de respostas gerados do contrato; nenhum script envia requisições |

Foram acrescentados 15 caminhos concretos, totalizando 22 operações novas no contrato-fonte. O catálogo interativo também recuperou operações Redis/RabbitMQ que já existiam no contrato, mas estavam ocultas.

## Console VoIP e limites

O wildcard `/admin/voip/console/*` encaminha JSON, não concede autorização ilimitada. A enumeração mantém as rotas de linhas/atribuição, credenciais, registros, modo SIP, grupos/áudio, histórico, gravação/configuração/limpeza, transferência de chamada e simulação/reservas do roteador. Recursos genéricos permanecem como compatibilidade, acompanhados de entradas concretas.

Os aliases binários upstream `/v1/console/history/:callId/recording` e `/v1/console/history-records/:recordId/recording` não são downloads suportados pelo proxy JSON genérico: ele lê texto e responde JSON. A entrada executável de download documentada é `GET /admin/voip/recordings/{recordId}`, que usa streaming. Não foram anunciados aliases de áudio inválidos como downloads funcionais. Login e usuários do console antigo permanecem removidos; use /manager.

O backend confirmado permite GET de bootstrap/zapo-lines/extensions e credentials do ramal automático próprio, além das chamadas ativas e accept/reject/end/mute. Permite também PUT /admin/voip/console/extensions/{extensionId}/sip-mode com capability extensionSipMode=true, corpo estrito {sipEndpointMode: extension|trunk} e retorno {extensionId, sipEndpointMode}. O ramal automático próprio em trunk não é excluído de listagem/credentials; ramal manual ou trunk externo/compartilhado permanece negado. Não libera remoção de registro, edição de sessão, configurações básicas ou originate. A transferência de atribuição não revoga senha SIP copiada ou registro ativo: requer processo administrativo separado de rotação/desconexão.

### Atualização coordenada: histórico e gravações

GET /admin/voip/console/history e GET /admin/voip/recordings/{recordId} passam a admitir usuário Manager com escopo, somente com Uno e VoIP compatíveis. O bootstrap upstream deve anunciar capabilities.managerSessionHistoryScope=1; versão antiga mantém history=false e recordings=false e nega acesso. Não há fallback para resultados globais.

O histórico filtra pelo snapshot phoneNumber e conta antes da paginação. A atribuição atual inclui todo o histórico do PN, inclusive anterior à atribuição; remover sessão não elimina acesso enquanto a atribuição persistir. Snapshot ausente/não confiável é excluído para usuário, sem inferência por empresa ou contato remoto; administrador inalterado.

O serviço Uno valida scope:{version:1,phones:[...]} e exige X-Unoapi-Session-Scope-Applied:1 antes do áudio. X-Unoapi-Session-Scope é header confiável interno com PNs JSON, não autenticação pública, variável Postman ou parâmetro de usuário. Gravação exige recordId exato, sem fallback para outro registro do mesmo callId. Respostas restritas excluem URLs globais e chaves de armazenamento. Novas requisições usam a atribuição atual; bytes/blobs já entregues não são revogáveis.

Os testes contratuais verificam ambas as capacidades (upstream compatível/legado), o esquema restrito, a autenticação normal do Manager e a ausência de headers internos nas requisições públicas e no Postman. Não substituem integração runtime nem smoke de produção.

## Verificação e reprodução

```sh
node scripts/openapi-to-json.mjs
node docs-site/scripts/sync-openapi.mjs
node scripts/openapi-to-postman.mjs
node docs-site/scripts/validate-docs.mjs
node node_modules/jest/bin/jest.js --runInBand --coverage=false __tests__/openapi_admin_inventory.ts __tests__/openapi_admin_panels.ts __tests__/postman_collection.ts
```

`__tests__/openapi_admin_inventory.ts` compara cada método administrativo explícito, incluindo rotas declaradas em múltiplas linhas e o subrouter Manager, com os contratos canônico/interativo e a coleção Postman. Verifica também CRUD concreto, capacidades restritas, autenticação, upload binário e confirmação destrutiva. A cobertura de wildcard é a enumeração verificada acima, não uma promessa para caminhos arbitrários.

Execute a validação para obter contagens atuais. Testes de contrato/build não substituem smoke test ou comprovação de isolamento em produção. Exemplos mutáveis são manuais; não executar a coleção inteira automaticamente.
