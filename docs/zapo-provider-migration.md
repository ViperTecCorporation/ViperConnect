# Transicao incremental Baileys -> Zapo

## Objetivo

Adicionar a Zapo como segundo motor do ViperConnect sem alterar o contrato HTTP da UnoAPI. A escolha e feita por sessao. Ao selecionar Zapo sem credenciais nativas, a sessao exige novo pareamento por QR; o motor Zapo nunca importa nem consulta o auth Baileys. Quando a matriz Zapo atingir 100% dos recursos usados pelo produto, a Baileys podera ser removida.

## Fontes de verdade

1. Contratos e casos de teste existentes em `__tests__`.
2. Documentacao oficial: <https://zapo.to/pt-br>.
3. Repositorio oficial: <https://github.com/vinikjkkj/zapo>.
4. Guia oficial de autenticacao: <https://zapo.to/en/concepts/authentication>.

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
- `WHATSAPP_ENGINE`: padrao para novas sessoes sem valor persistido; default `zapo`. Sessoes legadas ja persistidas sem `provider` continuam Baileys.
- `UNOAPI_WORKER_ENGINE`: motor exclusivo do processo worker; o runtime suportado e `zapo`.
- `UNOAPI_PROCESS_ROLE`: papel opcional do entrypoint cloud (`web`, `broker` ou
  `worker`). Quando ausente, inicia todos os papeis. O papel `broker` inclui os
  consumidores de bulk e commander; eles nao exigem outro container.
- Baileys e forwarder permanecem apenas no codigo de referencia e nao possuem worker ativo.

## Estado atual Zapo-only

- o Compose nao declara worker Baileys;
- a imagem e o comando Linux padrao iniciam `cloud.js`;
- o build de runtime parte de `cloud.ts` e nao emite `index.js`,
  `client_baileys.js` ou `listener_baileys.js`;
- sessoes Baileys persistidas aparecem offline e nao podem executar register,
  connect ou envio;
- `deregister` de sessao Baileys nao publica em fila sem consumidor: remove
  localmente auth, chaves transitorias, status e configuracao do Redis;
- depois da remocao, um novo register usa Zapo e exige pareamento nativo.

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

O `ClientZapo` permanece como fachada de compatibilidade durante a transicao.
Novas regras devem continuar sendo extraidas para modulos em
`src/services/zapo/*`; nao adicione novos dominios diretamente a fachada sem
adapter e teste dedicados.

## Pareamento Zapo obrigatorio

Fluxo obrigatorio ao iniciar uma sessao Zapo:

1. Adquirir a lease Redis `unoapi-lease:zapo-session:<telefone>`; somente o dono pode abrir o socket.
2. Verificar se o store Zapo possui credenciais registradas. Se possuir, reconectar com o auth nativo.
3. Sem credenciais Zapo registradas, criar um pareamento novo e emitir QR.
4. Solicitar full history no payload desse novo pareamento para hidratar contatos, PN/LID, privacy tokens e `nctSalt` enviados pelo aparelho.
5. Nunca ler `unoapi-auth:*` nem arquivos de auth Baileys a partir do motor Zapo.
6. Preservar o auth Baileys apenas como rollback independente durante a fase beta.
7. Manter a lease renovada durante a conexao e libera-la ao desconectar. Falha de renovacao derruba o socket de forma conservadora.

Os containers Baileys e Zapo podem coexistir. Para escalar replicas Zapo, preserve o roteamento por `server`/motor; a lease impede socket duplicado, mas nao substitui afinidade das filas por sessao.

Nao existe fallback silencioso de auth. Uma sessao configurada como Zapo permanece Zapo e solicita pareamento quando seu store nativo estiver vazio.

## Politica de testes

### Diagnóstico de desconexão

O evento `connection` fechado registra `ZAPO_CONNECTION_CLOSED` em nível warn,
com `phone`, `reason`, `code`, `isLogout`, `intentionalDisconnect` e
`wasConnected`. Motivo/código ausentes são `null`, sem inventar a causa.
São os campos do contrato `WaConnectionEvent` da versão instalada; não se
registra o evento inteiro, credenciais, QR, tokens ou conteúdo de mensagens.
Eventos de sockets já substituídos continuam ignorados. O log é somente
diagnóstico: não muda status, reconexão, pareamento nem encaminhamento VoIP.
`isLogout=true` indica desvinculação conforme o provider, não identifica quem
a provocou. Os novos detalhes só estarão disponíveis após publicar a versão.

Cada funcao nova tem pelo menos um teste dedicado. Funcoes com decisao, erro ou idempotencia exigem um caso por ramo relevante.

## Proxy Zapo

Quando `PROXY_URL` estiver configurada com uma URL SOCKS, o adapter cria um
unico transporte e o entrega explicitamente aos quatro canais oficiais da Zapo:
`proxy.ws`, `proxy.mediaUpload`, `proxy.mediaDownload` e `proxy.linkPreview`.
Assim, WebSocket, upload/download no CDN e busca de preview seguem a mesma
saida de rede. Sem URL configurada, a propriedade `proxy` e omitida.

Sem proxy, a família IP pode ser controlada globalmente por
`ZAPO_NETWORK_IP_FAMILY=auto|ipv6first|ipv4first` e sobrescrita por canal com
`ZAPO_CHAT_SOCKET_IP_FAMILY`, `ZAPO_MEDIA_UPLOAD_IP_FAMILY`,
`ZAPO_MEDIA_DOWNLOAD_IP_FAMILY` e `ZAPO_LINK_PREVIEW_IP_FAMILY`. Override vazio
herda a política global. `auto` preserva o caminho nativo sem agente adicional;
as duas preferências mantêm `autoSelectFamily`, portanto IPv4 e IPv6 continuam
disponíveis como fallback. O agente direto suporta HTTP, HTTPS e WSS e é
reutilizado no processo por política efetiva.

Com `PROXY_URL`, o agente SOCKS existente continua prioritário e nunca é
contornado por uma política de família. Em `socks5h`, DNS e família de saída são
decididos pelo proxy remoto.

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
| Mensagens | texto, midia, contato, interativo, enquete, raw e reacao | `client.message` | testado |
| Operacoes | responder, editar, apagar e recibos | `client.message` | testado |
| Midia | upload, download e decriptacao | message/media + media-utils | testado |
| Grupos | listar/cache, criar, metadata, alterar e sair | `client.group` | testado |
| Participantes | add/remove/promote/demote/aprovacoes | `client.group` | testado |
| Presenca | online/offline, composing, recording e paused | `client.presence` | testado |
| Contatos/perfil | verificacao, agenda sincronizada e foto de grupo | profile/app-state/privacy | testado |
| Historico | sync inicial, replay persistido e sob demanda | history sync | documentado |
| Eventos | message, receipt, addon, connection, group e username | event map/MEX | testado |
| Privacy token | consulta, bootstrap e cache | privacy token | testado |
| Passkey | bridge WebAuthn externo | `signPasskeyAssertion` | testado |
| Coexistencia | fluxo Meta especifico atual | sem coordinator equivalente documentado | sem capability |
| Chamadas | receber, rejeitar e fazer bridge de áudio ao vivo | plugin dedicado `vendor/zapo-voip`, `client.voip` | testado |
| Status | publicar e receber `status@broadcast` | `client.status` e evento message | testado |
| Catálogo | produto compartilhado e pedido itemizado no webhook | `productMessage`, `orderMessage` e `BizQueryOrder` | concluido |
| Recuperacao | reenviar preservando ID publico | `message.send({ id })` e retry interno | testado |
| Newsletter/broadcast list | rotas e eventos atuais | coordinators dedicados | nao iniciado |

Quando o servidor entrega uma mensagem de coexistência como placeholder
`message_unavailable` com `kind=hosted`, o conteúdo original não está disponível
para recuperação. A UnoAPI ainda encaminha ao webhook uma mensagem `type=text`
com o aviso `Mensagem indisponível nesta integração. Confira o aparelho.` para
evitar uma conversa sem conteúdo no sistema integrado. Isso não altera o estado
`sem capability`: o conteúdo original continua irrecuperável.

Desde `zapo-js` 1.7.0, placeholders comuns podem informar
`resendRequested=true`: nesse caso a UnoAPI aguarda o reenvio do aparelho e não
publica um aviso intermediário, pois a mensagem recuperada chega depois com a
mesma chave. Quando `resendRequested=false`, inclusive para `kind=bot` ou
`kind=other` fora da janela de recuperação, a UnoAPI encaminha o mesmo fallback
explícito ao webhook.

### Falhas de envio

Todas as ações que passam pelo envio comum de mensagens — texto, mídias,
contatos, interativos, enquete, voto, edição, reação, template, raw e atualização
de status — entregam à aplicação o mesmo webhook Cloud API com `status: failed`,
independentemente de a sessão usar Baileys ou Zapo.

Na Zapo, erros conhecidos da UnoAPI (`SendError`) geram o webhook
imediatamente. Exceções nativas ou potencialmente transitórias continuam usando
as tentativas configuradas da fila e geram o webhook na última tentativa. O
payload preserva o ID UnoAPI e inclui `code`, `title`, `message` e
`error_data.provider=zapo`; não inclui stack trace.

Operações administrativas executadas por HTTP/RPC, como alterações de grupo,
continuam retornando o erro na própria resposta HTTP. Elas não são transformadas
em webhook de falha de mensagem.

### Interativos Zapo

O adapter segue a referência oficial de tipos da Zapo:

- botões usam `interactiveMessage.nativeFlowMessage`;
- carrosséis usam `interactiveMessage.carouselMessage` e enviam explicitamente
  o nó comercial `interactive/native_flow`, pois os botões ficam dentro dos
  cartões e não são detectados no nível principal pela versão atual da Zapo;
- listas usam o `listMessage` raw com `ListType.SINGLE_SELECT`;
- listas não são convertidas para o botão native-flow `single_select`, pois esse
  formato pode ser renderizado pelo cliente como “atualize o WhatsApp”;
- cabeçalho de mídia em lista retorna capability explícita, porque o
  `listMessage` documentado não possui esse campo.
- cobrancas avulsas legadas usam `payment_info`, pedidos usam
  `order_details/review_and_pay` e atualizacoes usam `review_order`;
- conforme a documentação oficial da Meta para pagamentos Pix offsite no
  Brasil, o PIX dinâmico simplificado usa `order_details/review_and_pay` sem o
  objeto opcional `order`. Esse fluxo exibe total e ação para copiar o código;
  por retrocompatibilidade, um `payment_request` antigo contendo
  `pix_dynamic_code`, `payment_link`, `boleto` ou `offsite_card_pay` é
  normalizado para esse fluxo oficial e exige `total_amount`;
- `pix_static_code` continua aceitando a forma curta `payment_request`, enquanto
  `pix_dynamic_code`, `payment_link`, `boleto` e `offsite_card_pay` usam uma
  ordem `order_details/review_and_pay`, com o objeto `order` opcional;
- pedidos detalhados aceitam cabeçalho de imagem; pedidos simplificados, sem o
  objeto `order`, rejeitam esse cabeçalho;
- cabeçalhos de imagem são identificados por conteúdo antes da geração da
  miniatura. `file-type` é uma dependência direta do runtime e o estágio
  `production-dependencies` valida sua presença para não depender de hoisting
  acidental das dependências de desenvolvimento;
- a linha digitavel do boleto e normalizada para somente digitos antes do envio,
  e pedidos itemizados sem `tax` recebem imposto zero com o mesmo `offset` do
  total, pois ambos sao exigidos pelo checkout nativo;
- atualizações usam `order_status/review_order` e preservam os objetos
  `payment` e `order`;
- a referência usada por `order_status` é indexada a partir do botão normalizado
  `review_and_pay`, e não somente do tipo informado no payload HTTP. Assim,
  pedidos oficiais e envelopes legados convertidos podem ser atualizados com a
  mesma `reference_id` depois que a mensagem original alcançar `sent` ou
  `delivered`;
- webhooks de pedidos preservam `interactive.type=order_details`, cabeçalho,
  corpo, rodapé e `review_and_pay.parameters` tanto em `messages` quanto no eco
  Chatwoot `smb_message_echoes`; a representação textual da chave PIX permanece
  restrita à cobrança PIX simples e nunca achata um pedido detalhado;
- pedidos com `pix_dynamic_code` ou `pix_static_code` acrescentam no webhook um
  botão `cta_copy` com o código PIX completo em `copy_code.code`; o código não é
  convertido em link nem abreviado e permanece idêntico em `messages` e
  `smb_message_echoes`;
- cabeçalhos de mídia de carrossel preservam URLs públicas originais. Quando o
  evento recebido contém mídia criptografada do CDN do WhatsApp, a Uno baixa e
  descriptografa pelo adapter do provider, salva no storage configurado e envia
  a URL assinada em `interactive.carousel.cards[].header`. Se não houver dados
  de decrypt, usa `jpegThumbnail` quando disponível; nunca encaminha uma URL
  `mmg.whatsapp.net` ainda criptografada;
- códigos PIX, boletos, links e credenciais são gerados pelo banco ou PSP e a
  Uno apenas os transporta; pedido, total, moeda e identificador de referência
  não são recalculados;
- `offsite_card_pay` depende de habilitação comercial da conta e permanece
  pendente de validação real; o adapter e o webhook `payment_method` estão
  cobertos por testes, mas essa modalidade não deve ser anunciada como
  disponível para todas as sessões.

Referência:
`https://zapo.to/en/reference/message-types#interactive-business`.

### Prévia de links em texto

O adapter detecta automaticamente a primeira URL ou domínio público válido no
texto e envia `linkPreview: true` na mensagem tipada da Zapo, sem exigir uma flag
da aplicação. URLs HTTP(S) são preservadas. Um domínio sem protocolo é validado
por expressão, excluindo e-mail, IP, `localhost`, extensões comuns de arquivo e
host malformado, e recebe `https://` antes do envio para que a Zapo possa buscar
os metadados. A decisão não depende de `text.preview_url`; clientes antigos que
ainda enviem esse campo não alteram o comportamento automático.

Como o HTML do YouTube pode posicionar Open Graph depois do limite genérico de
leitura da Zapo, links `youtube.com` (incluindo Shorts) e `youtu.be` usam um
resolvedor `oEmbed` limitado por tempo e tamanho. A miniatura só é aceita por
HTTPS nos hosts oficiais `i.ytimg.com` e `img.youtube.com`. Esse resolvedor usa o
mesmo agente de `proxy.linkPreview`/família IP do cliente; transporte
desconhecido não é contornado. Qualquer erro retorna ao coletor genérico sem
bloquear o envio do texto.

As ações de administrador de grupo são expostas por
`PATCH /v15.0/{phone}/groups/{groupId}/participants`, com `action` igual a
`promote` ou `demote`. O controller preserva o contrato LID-first e aceita o
envelope com `wa_id` e `user_id`.

O estado público do grupo é consultado em
`GET /v15.0/{phone}/groups/{groupId}`. Para os dois motores, o controller
converte `announce` em `announcement` e `restrict` em `locked`, preservando
valores `false` e omitindo somente metadata indisponível.

Na criacao de grupos, o contrato publico continua aceitando LID, PN ou o envelope
com ambos. A versao atual da Zapo anuncia `group_create_add_using_lid_jids=false`;
por isso, somente antes de `client.group.createGroup` e `client.group.addParticipants`
a Uno resolve cada identidade para o PN canonico persistido no store Zapo. Esse PN nao
recebe normalizacao brasileira de apresentacao. Ausencia do mapeamento LID -> PN retorna
`zapo_lid_phone_not_found` em vez de fabricar ou alterar o numero. As demais operacoes
de grupos permanecem LID-first.

`sem capability` e uma limitacao explicita, sem fallback silencioso para Baileys. O
passkey manual usa o callback oficial `signPasskeyAssertion` e o bridge HTTP/Redis da
Uno; nao existe confirmacao manual adicional na Zapo. Newsletter e listas de transmissao
devem permanecer desabilitadas para sessoes Zapo ate ganharem adapter e testes de contrato.

### Lifecycle do passkey Zapo

Segundo a [documentacao oficial de autenticacao](https://zapo.to/en/concepts/authentication),
`auth_passkey_required` e apenas um aviso. A biblioteca executa o Shortcake internamente,
chama `signPasskeyAssertion` com as opcoes WebAuthn e conclui pelo evento `auth_paired`.

- o evento libera a requisicao de conexao para a aplicacao continuar consultando
  `/passkey-bridge/pending`;
- `response-sent` significa somente que a assertion foi devolvida ao signer;
- apenas `auth_paired` muda o bridge para `completed`;
- falha, timeout ou fechamento da conexao rejeitam o signer pendente;
- reconexao normal reutiliza credenciais persistidas e nao exige novo passkey/QR;
- `logout()` remove o dispositivo e exige novo pareamento; `disconnect()` preserva as
  credenciais.

Manter esta tabela atualizada no mesmo commit que muda o estado de uma capacidade.

### Enquetes Zapo

A Uno traduz `type: poll` para a API tipada documentada pela Zapo. O formato aceito pela
rota de mensagens e:

```json
{
  "to": "5511999999999",
  "type": "poll",
  "poll": {
    "name": "Almoco?",
    "options": ["Pizza", "Sushi", "Salada"],
    "selectableCount": 1,
    "allowAddOption": false
  }
}
```

Para votar, informe o ID UnoAPI devolvido ou recebido para a enquete. O adapter resolve
o ID interno da Zapo e le o `messageSecret` no store oficial; a aplicacao nao deve calcular
hashes nem persistir segredo de enquete no Redis:

```json
{
  "to": "5511999999999",
  "type": "poll_vote",
  "poll_vote": {
    "message_id": "ID_UNOAPI_DA_ENQUETE",
    "selected_options": ["Pizza"]
  }
}
```

Votos recebidos chegam pela Zapo como `message_addon` ja descriptografado. O webhook Uno
expoe um texto como `*Voto em enquete*: Pizza` e inclui `context.message_id` com o ID da
enquete original. A ordem e a grafia das opcoes devem ser preservadas, conforme o
[guia oficial de mensagens interativas](https://zapo.to/en/guides/interactive-messages).

Desde `zapo-js` 1.8.0, a descriptografia oficial da própria Zapo é sempre a primeira
tentativa para addons. O fallback legado de voto permanece temporariamente apenas quando
a tentativa oficial não emite um addon legível. Os logs resumidos
`ZAPO_ADDON_DECRYPT path=official` e `path=legacy_poll_fallback` permitem medir o uso do
fallback sem registrar conteúdo, segredo ou payload descriptografado. O evento sensível
`debug_decrypted_payload` não é habilitado pela UnoAPI.

### Edicao de mensagens Zapo

O payload publico permanece `type: message_edit`, com o ID UnoAPI original em
`context.message_id` e o novo texto em `text.body`. O adapter resolve o ID do provider,
confirma que a mensagem original e `fromMe` e chama `client.message.send` com o novo
conteudo e `editKey: { id, participant? }`. O participante somente e preservado em grupo.
Ausencia do ID, mensagem desconhecida ou tentativa de editar mensagem recebida retornam
erro e nunca viram silenciosamente uma nova mensagem de texto.

Edicoes recebidas pelo evento `message_addon` sao convertidas para `MESSAGE_EDIT`; antes
do webhook, o listener converte o ID original Zapo novamente para o ID UnoAPI.

### Catálogo e pedidos recebidos

`productMessage` e `orderMessage` seguem os tipos oficiais documentados pela
Zapo. O transformer publica respectivamente `messages[].type=product` e
`messages[].type=order`, sempre com `fallback_text`.

Produtos preservam identificador, SKU, título, descrição, preço, promoção, URL
e imagem. A imagem criptografada é baixada com `client.message.downloadBytes` e
copiada para o media storage Uno antes do webhook.

Pedidos usam `orderId`, `sellerJid` e `token` somente dentro do adapter
`ZapoOrderResolver`. A consulta MEX `BizQueryOrder`, cuja assinatura e resposta
estão declaradas na versão oficial fixada de `zapo-js`, recupera produtos,
quantidade, preços, moeda, variantes e imagens. O token nunca entra no
transformer nem no webhook.

Falha de consulta ou mídia não bloqueia a conversa. O pedido sai com
`resolution_status=failed` ou `summary`; quando há itens, sai como `resolved`.
`orderRequestMessageId` é convertido de ID Zapo para ID UnoAPI antes de preencher
`context.message_id`.

### Recuperação de mídia expirada

Ao baixar uma mídia de mensagem, a UnoAPI usa primeiro o fluxo normal da Zapo. Somente
quando o CDN responde explicitamente HTTP `404` ou `410`, o adapter solicita uma vez o
reupload autenticado por `client.message.requestMediaReupload()` e repete o download com
o novo `directPath`. A mensagem original não é alterada.

Timeout, HTTP `5xx`, falha genérica, mídia de newsletter e respostas `not_found`,
`decryption_error` ou `general_error` não entram em ciclo de retry. Esse limite evita
duplicidade, rajadas de rede e tentativas incompatíveis com o contrato oficial. Os logs
informam apenas sessão, ID da mensagem e resultado; chave de mídia, URL e conteúdo não
são registrados.

O contrato e exemplos fictícios estão em [CATALOG_WEBHOOKS.md](CATALOG_WEBHOOKS.md).

O contrato operacional, as configurações por sessão e os exemplos da rota de replay/sync estão em [MESSAGE_HISTORY.md](MESSAGE_HISTORY.md).

O worker mantém somente os 100.000 IDs de mensagens mais recentes por sessão,
por até 30 dias, para impedir que a deduplicação de replay cresça sem limite.
Os caches auxiliares de foto de perfil também são limitados a 5.000 identidades
por sessão e expiram conforme a maior janela de refresh/webhook (mínimo 24h).
Quando ocorre uma expulsão, a Uno relê o dado do store persistente; credenciais,
mensagens e arquivos de mídia não são removidos.

## Enderecamento 1:1 Zapo

- O campo publico de enderecamento e `to`; ele aceita PN/`wa_id`, LID ou username.
- Um LID ou username informado diretamente em `to` tem prioridade. Quando `to` contiver somente o PN de apresentacao, `user_id` ou `to_user_id` podem fornecer o LID canonico do destinatario.
- Quando o LID estiver presente, a UnoAPI envia por ele e consulta `contacts.getByJid` para recuperar o PN exato armazenado pela Zapo.
- O PN do store entra no envelope do provider sem inserir nem remover o nono digito. A normalizacao brasileira fica restrita ao webhook publico da aplicacao.
- Sem LID, um `username` conhecido e resolvido pelo indice Zapo para seu LID. Alias ainda nao sincronizado retorna erro explicito.
- Quando a aplicacao nao conhecer LID nem username, a UnoAPI consulta primeiro o
  PN exato no contact store persistente da sessao Zapo. Um LID armazenado e usado
  diretamente, sem nova consulta de rede. Se o envio rejeitar esse LID como
  inexistente, a protecao de renovacao consulta a rede, substitui os mapeamentos
  antigos e repete o envio uma vez.
- Para celulares brasileiros recebidos com o nono digito, somente depois de um
  cache miss exato o resolver tenta no mesmo store o PN legado sem esse digito.
  O PN exato sempre vence quando as duas formas existirem. Esse fallback nao se
  aplica a numeros internacionais, nao fabrica um LID e nao altera o PN enviado
  para a consulta de rede.
- Somente quando o PN exato nao estiver no store a UnoAPI chama
  `profile.getLidsByPhoneNumbers`. Consultas simultaneas do mesmo PN na mesma
  sessao compartilham a mesma requisicao pendente, reduzindo flood e risco de
  restricao. O resultado canonico e persistido para os proximos envios.
- Falha de transporte relê o store uma vez para cobrir uma atualizacao concorrente.
  Uma resposta de rede explicita sem LID continua retornando
  `zapo_phone_lid_not_found`; a Uno nao fabrica identidade.
- Fora desse fallback local e ordenado, nunca escolher um contato Zapo por
  heuristica de 8/9 digitos: PNs diferentes podem coexistir e apontar para LIDs
  distintos.

### Verificacao e importacao de contatos

As rotas `POST /{phone}/contacts` e `POST /{phone}/contacts/import` usam um
resolver isolado do enderecamento de mensagens e grupos. Um mapeamento recente
do store Zapo (janela de cinco minutos) evita consultas repetidas; os demais
telefones sao enviados em uma unica consulta em lote por requisicao. A resposta
e correlacionada por `queriedJid`, nunca pela posicao do array.

Falha de transporte usa um registro antigo do store somente como fallback. Sem
resultado confiavel, a rota retorna `503 zapo_contact_lookup_unavailable`, para
retry externo espacado, e nao executa varias consultas imediatas que possam
aumentar o risco de restricao da sessao. Uma resposta de rede explicita com
`exists=false` e tratada como contato invalido.

A normalizacao brasileira de apresentacao e aplicada na entrada e na resposta
publica. O `phoneJid` canonico devolvido pela Zapo continua armazenado sem
alteracao para o enderecamento interno. Na importacao, um `user_id` fornecido
pela aplicacao nao substitui o LID canonico: aliases antigos pertencentes ao
mesmo telefone sao removidos, e a mutacao `Contact` e ignorada quando telefone,
LID e nome ja forem iguais.

`GET /{phone}/contacts` devolve `total_count` apenas para chaves canonicas
`@lid`, alem de `raw_total_count` e `ignored_count`, preservando a paginacao por
cursor e tornando divergencias do cache observaveis. A busca por nome,
username, telefone ou LID começa com 3 caracteres: o front não envia termos
menores e a rota HTTP os rejeita para evitar varreduras desnecessarias no cache.

A listagem de contatos resolve fotos somente pelo cache Redis e nunca varre o
storage S3/R2/MinIO contato por contato. Quando a URL legada estiver no cache,
ela continua em `picture` para retrocompatibilidade; `picture_id` e sempre
devolvido quando houver uma identidade PN/LID valida. Consumidores novos e o
frontend carregam somente os avatares visiveis pela rota autenticada
`GET /v13.0/{session}/profile-pictures/{picture_id}`. Ausencias nessa rota sao
cacheadas e consultas concorrentes no frontend sao deduplicadas, evitando
rajadas de `HeadObject` durante sincronizacoes completas.

## Username

A identidade canonica Zapo e o LID. `senderUsername`, participantes de grupo e eventos
MEX alimentam um indice temporal `username -> LID`. A partir de `zapo-js` 1.8.0, os
campos oficiais `recipientUsername` e `participantUsername`, além do evento
`own_username`, também atualizam o índice quando há um LID correspondente.

A API aceita envio/consulta por `@username`. O índice local continua sendo a primeira
fonte; somente uma consulta explícita de contato por username ainda desconhecido usa
`client.profile.resolveUsername()`. Resultado `found` persiste username, LID e PN no
store oficial. `not-found`, `key-required` ou erro de rede retornam contato inválido sem
inventar telefone por heurística. O enriquecimento rotineiro de webhooks nunca consulta
a rede apenas para descobrir username.

Quando a Zapo omite o username em uma mensagem posterior, a Uno consulta somente esse
indice local, sem fazer uma nova consulta à rede do WhatsApp, e enriquece
`contacts[].profile.username` nos webhooks de mensagens, addons, protocolos e replay de
historico. O mesmo fallback LID -> username e aplicado em `GET /{phone}/contacts`, em
`POST /{phone}/contacts` e nos lotes internos `contacts.update` enviados pelo job de
sincronizacao. O username nativo do evento ou do contato sempre tem prioridade sobre o
indice temporal; ausencia no cache preserva o payload anterior sem erro.

## Histórico Zapo 1.8

O contrato HTTP, o replay e o filtro por idade permanecem inalterados. A atualização para
`zapo-js` 1.8.0 passa a consumir o histórico de pareamento por streaming, mantendo
somente o lote necessário durante a persistência e o ACK. Isso reduz o pico de memória
sem alterar `history_sync_chunk`, deduplicação, IDs UnoAPI ou encaminhamento de webhook.

## Preparacao de video para envio Zapo

### Entrada alternativa de mídia em Base64

O contrato HTTP mantém `link` como origem compatível com a Cloud API e aceita,
como extensão ViperConnect, `base64` puro ou Data URI em imagem, áudio, vídeo,
documento e sticker. O processo web decodifica e valida a entrada, salva os
bytes no media store e substitui o Base64 por uma referência interna antes da
publicação AMQP. A Zapo recebe a origem documentada `Uint8Array | string`; em
storage local usa o caminho persistido e em storage S3 compatível usa a URL
assinada gerada pelo SDK.

Base64 nunca deve aparecer em logs, webhooks ou mensagens RabbitMQ. Vídeo já
persistido por esse fluxo entra diretamente na fila de transcode com a chave do
objeto, sem repetir download no estágio. `link` continua seguindo exatamente o
fluxo anterior.

Videos com link externo nao entram diretamente na fila serial da sessao. O broker
usa duas filas globais separadas:

- `unoapi.video.stage`: faz download por streaming e guarda a origem no media
  store antes que URLs assinadas curtas expirem; o prefetch padrao e 4;
- `unoapi.video.transcode`: possui prefetch 1 e executa no maximo uma preparacao
  pesada por processo broker.

Depois da preparacao, a mensagem volta para a fila `incoming` Zapo com o mesmo ID
Uno. Mensagens de texto e demais tipos continuam no fluxo normal e podem ultrapassar
um video que ainda esteja sendo preparado. Essa reordenacao intencional impede que
uma conversao longa bloqueie a sessao inteira.

Se staging ou conversao esgotarem as tentativas, a Uno publica um status Meta-like
`failed` com codigo de midia `131053`, mantendo o mesmo ID devolvido na requisicao.
Assim a aplicacao nao fica aguardando indefinidamente uma mensagem aceita pela API.

Video H264/AAC compativel e menor que o alvo recebe apenas remux com `faststart`.
Os demais sao convertidos com prioridade baixa (`nice 10`) para MP4 H264 Main 4.0,
`yuv420p`, AAC, no maximo
1280x720 ou 720x1280. O FFmpeg usa uma thread e a saida fica abaixo de 15 MiB,
com uma segunda tentativa de bitrate reduzido quando necessario. Entradas acima
de 256 MiB sao rejeitadas explicitamente.

Controles runtime:

- `UNOAPI_VIDEO_STAGE_PREFETCH` (padrao `4`);
- `UNOAPI_VIDEO_MAX_INPUT_BYTES` (padrao `268435456`);
- `UNOAPI_VIDEO_TARGET_BYTES` (padrao `15728640`, nunca acima de 15 MiB);
- `UNOAPI_VIDEO_STAGE_TIMEOUT_MS` (padrao `300000`);
- `UNOAPI_VIDEO_TRANSCODE_TIMEOUT_MS` (padrao `420000`, limitado pelo timeout
  geral do consumidor).

Por compatibilidade, `UNOAPI_VIDEO_WORKER_MODE=broker` (ou variável ausente)
mantém esses consumidores no processo broker. Para isolar CPU, configure o
broker com `UNOAPI_VIDEO_WORKER_MODE=dedicated` e execute outra instância com
`UNOAPI_PROCESS_ROLE=video`. O modo dedicado não faz failover automático: se a
instância parar, os jobs ficam duráveis no RabbitMQ e o broker não assume a
conversão silenciosamente.

O isolamento foi motivado por validação real: um vídeo de 106,9 MB, 1920x1080 e
6min30s manteve um núcleo ocupado por aproximadamente 3min30s. A fila da sessão
permaneceu livre, mas sem worker dedicado essa CPU ainda pertencia ao broker.

## Auditoria completa

O resultado classe a classe e mantido em `docs/zapo-class-audit.md`.

## Criterio para retirar Baileys

A Baileys somente pode ser removida quando:

- todas as sessoes ativas tiverem sido pareadas diretamente na Zapo;
- todos os dominios usados estiverem `concluido` ou houver decisao de produto documentada para remover o recurso;
- testes de contrato Zapo cobrirem todos os endpoints dependentes do WhatsApp;
- nao houver fallback Baileys em producao por um ciclo de observacao definido;
- rollback de dados tiver sido validado antes da remocao final.

## Supressão do runtime Baileys

O runtime e a imagem padrão são Zapo-only. A Baileys permanece somente como
dependência de desenvolvimento para compilar e testar o código legado. O build
normal parte de `src/cloud.ts`, valida automaticamente que não há import estático
ou artefato crítico da Baileys e a imagem copia apenas dependências de produção.

As sessões Baileys persistidas ficam offline e só podem usar o fluxo de
`deregister`, que limpa seus dados legados sem iniciar um socket. O procedimento
deliberado para recolocar o motor está em
[BAILEYS_REACTIVATION.md](BAILEYS_REACTIVATION.md).

### Limpeza one-shot das filas RabbitMQ antigas

O processo `broker` executa no boot a migration
`rabbitmq-zapo-only-queues-v1`. Ela remove somente:

- filas das famílias `bind`, `incoming`, `listener`, `reload` e `logout` com
  motor explícito `baileys`, incluindo variações `.dead` e `.delayed`;
- filas das mesmas famílias com servidor, mas sem motor, criadas pelo
  roteamento legado;
- filas `reload.undefined` e suas variações.

Filas Zapo e filas globais como `outgoing`, `media`, `timer`, `broadcast`,
`notification`, `transcribe`, `bulk`, `blacklist` e `commander` são
preservadas.

Antes de excluir qualquer fila, a migration verifica todas as filas-alvo. Se
alguma possuir consumidor ou mensagem `unacked`, a execução inteira é
abortada, nenhuma fila é removida e o marcador não é gravado. Portanto, o
container worker Baileys deve ser removido antes de subir a versão que contém
essa migration.

Depois do preflight, um lock Redis impede execução concorrente. A conclusão é
registrada de forma persistente em
`unoapi-app:migration:rabbitmq-zapo-only-queues-v1:done`, junto com os nomes
removidos e a quantidade de mensagens descartadas. O marcador torna a
migration idempotente e também permite que uma eventual reativação futura da
Baileys recrie suas filas sem que elas sejam apagadas em todos os boots.
