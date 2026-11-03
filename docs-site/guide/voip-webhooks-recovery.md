# Recuperação REST e diagnóstico VoIP

O webhook entrega eventos em tempo real. A consulta REST permite ao ViperChat recuperar eventos que não chegaram ou ainda não foram processados. Os dois caminhos usam o mesmo evento persistido pelo produtor e atualizam a mesma ligação, sem duplicar chamadas, notas ou anexos.

Veja também o [guia de configuração](/guide/voip-webhooks) e a [referência de eventos e estados](/guide/voip-webhooks-contract).

## Configurar a recuperação

No serviço VoIP do ViperChat, selecione a integração `viperconnect` e informe:

| Campo | Valor |
| --- | --- |
| `history_api_url` | URL base HTTPS do serviço VoIP, sem acrescentar `/voip-api`. Não é a URL do Manager. |
| `history_api_token` | Token `VOIP_SERVICE_TOKEN` da central, usado como Bearer. |
| `history_company_id` | ID exato da empresa na central; pode ser um UUID. Não inferir pelo telefone. |

A conta, o serviço e a origem devem corresponder ao cadastro do webhook. A empresa e a integração precisam estar habilitadas, e os vínculos atuais dos ramais devem autorizar os eventos.

Sem uma empresa explícita, a recuperação informa `configuration_required` e não faz uma consulta global. Um serviço cadastrado apenas como `webhook` informa `unsupported` para recuperação REST, mas continua recebendo eventos pelo webhook.

Credenciais REST ficam no servidor, não no navegador. Para uma origem HTTPS em rede privada, o operador pode autorizar a origem exata em `VOIP_TRUSTED_SERVICE_ORIGINS`, no ViperChat. A lista é separada por vírgulas e aceita origens como `https://host:porta`, sem caminho, credenciais, parâmetros ou fragmento. O padrão é vazio. Essa permissão não substitui a validação TLS, não aceita redirecionamentos e não deve ampliar globalmente `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`.

## Consultar os eventos

```text
GET /v1/console/history?sync=webhook_events&company_id=empresa-a&account_id=1&service_id=206&source_instance_id=central-empresa-a&limit=100
Authorization: Bearer <VOIP_SERVICE_TOKEN>
```

| Parâmetro | Obrigatório | Regra |
| --- | --- | --- |
| `sync` | Sim | Valor `webhook_events`. |
| `company_id` | Sim | ID da empresa no serviço VoIP. |
| `account_id` / `service_id` | Sim | Conta e serviço no ViperChat. |
| `source_instance_id` | Sim | Origem estável cadastrada nas duas pontas. |
| `limit` | Não | Inteiro de 1 a 100; padrão `100`. |
| `cursor` | Não | Cursor opaco da página anterior, com até 2048 bytes. |

Não misture os parâmetros de busca, datas ou paginação do histórico comum com esse modo. `sync=changes` retorna registros de chamadas, não os envelopes canônicos usados nesta integração.

### Resposta e paginação

```json
{
  "version": 1,
  "phase": "snapshot",
  "scope": {
    "company_id": "empresa-a",
    "account_id": "1",
    "service_id": "206",
    "source_instance_id": "central-empresa-a"
  },
  "items": [],
  "nextCursor": "cursor-opaco-assinado",
  "hasMore": false
}
```

O exemplo mostra uma página vazia. Cada item de uma página preenchida contém `sequence` e `webhook_event`. O evento é o envelope completo originalmente persistido na outbox, igual ao enviado por webhook; `sequence` corresponde a `revision`.

1. Na primeira consulta, omita o cursor para iniciar o `snapshot` dos eventos retidos.
2. Persista a página com segurança antes de salvar seu `nextCursor` como ponto de retomada.
3. Repita todos os filtros e envie `cursor=<nextCursor>` nas consultas seguintes.
4. Siga `hasMore`, sem deduzir o fim pelo número de itens. Ao alcançar a origem, continue a consulta periódica com o cursor recebido, na fase `changes`.

As respostas não são armazenadas em cache. Páginas vazias também fornecem um cursor válido. O servidor limita a página a 100 itens e a 1.500.000 bytes de eventos, podendo retornar menos itens. As revisões não precisam ser consecutivas para uma empresa.

O cursor é assinado e vinculado à instância, à empresa e ao destino. Preparação dos envelopes e cálculo do ponto de retomada são atômicos: o cursor não avança sobre eventos ainda não preparados. Se a preparação exceder o limite por requisição, a API retorna `503` para uma nova tentativa.

### Consolidação no ViperChat

O ViperChat guarda, por serviço, o cursor criptografado, a identificação da configuração e uma reserva temporária de processamento para evitar consultas concorrentes. A consulta periódica ocorre a cada minuto. Antes de persistir uma página, o cliente verifica novamente a configuração e a reserva.

A página recebida e o cursor são gravados na mesma transação. As tarefas de processamento são enfileiradas depois; uma varredura recupera os registros que ficaram sem tarefa após uma falha. Receber um webhook isolado não avança o cursor REST.

Webhook e REST passam pelo mesmo processo de consolidação: deduplicam por serviço, origem e `event_id`/`revision`, preservam `call_id` e ignoram revisões obsoletas. Reprocessar histórico não repete uma ação SIP nem faz uma chamada encerrada tocar novamente.

### Erros e lacunas

| Resposta | Tratamento |
| --- | --- |
| `400` | Corrigir parâmetros, limite ou cursor. Não apagar o ponto de retomada silenciosamente. |
| `401` / `403` | Rever token, empresa e permissões. Não repetir indefinidamente. |
| `409` | Rever o escopo ou o destino alterado, sem misturar instalações. |
| `410` | Cursor expirado. Reconciliar um novo snapshot retido e registrar a lacuna (`gap_detected`), sem apagar o histórico local. |
| `422` | Um evento excede o tamanho permitido; exige diagnóstico. |
| `501` | O armazenamento não oferece a outbox SQLite exigida pelo fluxo. |
| `503`, demais `5xx` ou falha de conexão | Aguardar com intervalos progressivos e tentar novamente sem avançar o cursor. |

O feed cobre apenas eventos retidos, autorizados e posteriores à ativação. A ausência de um evento não autoriza excluir histórico local. Uma lacuna anterior à retenção não pode ser reconstruída por essa API. Trocar a configuração exige nova validação; não redirecione pendências antigas para outro destino.

## Diagnóstico e reprocessamento

Há operações distintas no produtor e no ViperChat. Reprocessar um registro não altera o destino, não corrige falta de autorização e não substitui evidências ausentes de associação com uma conversa.

### No serviço VoIP

As rotas abaixo exigem Bearer do serviço e identificação de uma empresa. Quando acessadas pelo Manager, exigem um administrador.

```text
GET /v1/console/companies/:companyId/viperchat-webhook/diagnostics?status=all&limit=50
POST /v1/console/companies/:companyId/viperchat-webhook/replay
```

O diagnóstico aceita `status` igual a `all`, `pending`, `published`, `delivering` ou `dead`; `limit` vai de 1 a 100, com padrão 50. Retorna contagens e metadados técnicos de pendências, sem conteúdo, telefones, áudio ou credenciais.

O pedido de reprocessamento usa:

```json
{
  "confirm": true,
  "requestId": "d1957969-33e7-49be-955c-e83fafc06e71",
  "eventIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
}
```

Informe de 1 a 20 IDs de eventos distintos e um UUID novo por operação. A repetição do mesmo pedido usa o mesmo UUID e os mesmos IDs, sem agendar novamente. O lote é atômico e auditado; reutilizar o UUID com outro lote gera conflito.

O servidor preserva envelope, IDs, destino e contagem de tentativas. Uma falha que já atingiu o limite recebe uma nova tentativa e pode voltar a `dead` se falhar. Entrega já concluída, reserva de envio ainda ativa, destino alterado ou desabilitado e mudança dos vínculos autorizados podem gerar `409`. A resposta de agendamento não confirma a entrega ao ViperChat.

### No ViperChat

As rotas ficam sob `/api/v1/accounts/:account_id/voip/services/:service_id` e exigem um administrador dessa conta, com a autenticação de API do ViperChat.

| Rota | Uso |
| --- | --- |
| `GET /diagnostics` | Contagens, até 25 eventos e 25 artefatos pendentes ou falhos, indicador de truncamento e estado da recuperação, sem conteúdo ou credenciais. |
| `POST /reprocess` | Reprocessa um registro: `{"kind":"event","record_id":123}` ou `{"kind":"artifact","record_id":123}`. Retorna `202` com estado `queued`. |
| `POST /recover_history` | Solicita recuperação REST com `{"reset_cursor":false}`. Use `true` somente após confirmação explícita para reler os eventos retidos. |

O reprocessamento preserva IDs, conteúdo, associação com a conversa e arquivos já obtidos. Rejeita registros concluídos, outra conta ou serviço, origem alterada, serviço desabilitado e repetição em menos de 30 segundos. Operador e horário ficam registrados para auditoria. Falhas de eventos ou artefatos param após oito tentativas.

## Entrega durável e filas

O serviço VoIP grava a mudança e a outbox na mesma transação SQLite. O RabbitMQ recebe apenas o identificador da outbox, nunca o evento completo ou o token. A publicação é persistente e confirmada; o consumidor confirma a mensagem somente após o tratamento seguro da entrega, da retentativa ou da falha definitiva.

O transporte pode entregar o mesmo evento mais de uma vez. O consumidor verifica o destino atual antes de enviar e exige um recibo JSON correspondente. Mudanças de instalação, conta, serviço ou origem colocam pendências incompatíveis em quarentena. A rotação do token da mesma integração preserva os eventos.

O transporte usa oito tentativas, até quatro mensagens simultâneas e timeout HTTP de 15 segundos. A resposta de confirmação aceita até 16 KiB. As retentativas usam espera exponencial com base de 30 segundos, variação aleatória de 0,75 a 1,25, teto exponencial de 15 minutos e `Retry-After` limitado a uma hora. Os intervalos são agrupados em 1 s, 5 s, 30 s, 1 min, 2 min, 5 min, 15 min e 1 h; o agrupamento pode alongar a espera.

As filas principais são `viperconnect.voip.webhooks.outgoing` e `viperconnect.voip.webhooks.dead`. Os prazos de retentativa ficam na outbox SQLite; o transporte utiliza filas temporizadas `viperconnect.voip.webhooks.retry.<milissegundos>` para aguardar e reenviar. Não há uma fila `.delayed` nesse fluxo. Falhas permanentes ou tentativas esgotadas vão para `dead`, sem apagar a outbox. Não há reenvio automático da fila de falhas; use o reprocessamento administrativo confirmado.

## Persistência e limites operacionais

Mantenha `CALL_HISTORY_STORAGE` e `VOICE_CONFIG_STORAGE` em SQLite, com `VOIP_SQLITE_PATH` em volume persistente. Faça backup antes de migrações e não apague o volume, o banco ou as gravações para corrigir uma entrega.

A expiração de uma gravação não equivale à exclusão do histórico: a retenção preserva IDs e referências, inclusive quando o registro principal da chamada já saiu do catálogo. Falhas na remoção mantêm a referência para outra tentativa. Uma gravação em andamento não deve ser removida.

Para certificados privados, use uma cadeia confiável, como a indicada por `NODE_EXTRA_CA_CERTS` no produtor. Não desative TLS nem siga redirecionamentos para contornar falhas. Confirmação do RabbitMQ, aceite HTTP e conclusão de uma nota privada são etapas diferentes.
