# Telefonia Zapo

O ViperConnect mantém a única sessão Zapo e conecta o worker responsável ao
serviço de telefonia por `WS /v1/bridge/zapo`. O serviço VoIP não cria outro QR,
repositório de credenciais ou socket de sessão. Se ele ficar offline, as
mensagens continuam funcionando e a telefonia aparece como indisponível.

## Configuração da Uno

```bash
VOIP_SERVICE_URL=http://host.docker.internal:3097
VOIP_BRIDGE_URL=wss://voip.seudominio.com.br/v1/bridge/zapo
VOIP_SERVICE_TOKEN=gere-um-token-longo
VOIP_MAX_CONCURRENT_CALLS=2
```

No Compose público, declare `VOIP_BRIDGE_URL` explicitamente com `wss://` e
configure o proxy para aceitar WebSocket em `/v1/bridge/zapo`. Em uma rede
local sem TLS ela pode ser omitida; nesse caso a Uno deriva
`ws://host.docker.internal:3097/v1/bridge/zapo` de `VOIP_SERVICE_URL`.

## Configuração do serviço VoIP

```bash
PORT=3097
VOIP_SERVICE_TOKEN=gere-um-token-longo
VOIP_BRIDGE_TOKEN=gere-um-token-longo
VOIP_MAX_CONCURRENT_CALLS=2
```

O valor de `VOIP_BRIDGE_TOKEN` deve ser igual ao `VOIP_SERVICE_TOKEN` usado pela
Uno. O token nunca é enviado ao navegador.

## Docker e rede

No Docker Compose standalone, o serviço VoIP usa `network_mode: host` para SIP,
RTP e WebRTC, enquanto Uno, Valkey e RabbitMQ permanecem em bridge. O worker
Uno acessa o host por:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  VOIP_SERVICE_URL: http://host.docker.internal:3097
  VOIP_BRIDGE_URL: wss://voip.seudominio.com.br/v1/bridge/zapo
  VOIP_SERVICE_TOKEN: gere-um-token-longo
  VOIP_MAX_CONCURRENT_CALLS: "2"
```

Para executar a telefonia fora de container com pacote `.deb` e `systemd`, veja
[Telefonia em Linux nativo](/guide/install-voip-native-linux).

SIP, RTP, WebRTC e o proxy de mídia suportam IPv4 e IPv6 em paralelo a partir
da telefonia `v0.1.61` e da imagem unificada `v4.0.15`. A configuração pública
por família, Coturn e os testes de aceite estão em
[VoIP dual-stack IPv4 e IPv6](/guide/voip-ipv6).

## Proxy SIP/SBC com relay RTP privado

Por segurança, quando um peer público anuncia um endereço privado em
`c=IN IP4`, a telefonia mantém a proteção NAT e usa o endereço de origem da
sinalização. Um SBC ou proxy SIP pode, porém, sinalizar por IP público e
encaminhar a mídia por um relay privado que seja roteável a partir do host VoIP.

Autorize somente os IPs públicos de sinalização desses proxies:

```dotenv
SIP_RTP_TRUSTED_PRIVATE_SDP_PEERS=203.0.113.20,203.0.113.21
```

Essa variável é uma allowlist de peers, não o IP público do ViperConnect. Ela
vale para offer, answer e re-INVITE. Deixe-a vazia para ramais diretos. Não use
wildcards, hostnames ou redes amplas. A configuração não cria rotas nem abre
portas: se houver NAT, encaminhe toda a faixa
`SIP_RTP_MEDIA_PORT_MIN`–`SIP_RTP_MEDIA_PORT_MAX` até o host VoIP.

No Docker Swarm, não use `network_mode: host`. O worker e a telefonia se
encontram pelo DNS da overlay interna. `5060/udp` permanece em `mode: host`, e
as faixas fixas RTP/WebRTC usam a sintaxe compacta aceita pelo stack. O modelo
Traefik deixa HTTP e WebSocket nas overlays; o modelo Nginx publica também
`9876/tcp` e `3097/tcp` no nó de borda. Veja [Docker Swarm](/guide/docker-swarm)
para baixar os stacks completos.

Os Composes para download já incluem essa topologia e o volume persistente do
serviço VoIP. Todos os containers ViperConnect usam a mesma imagem e tag;
`UNOAPI_PROCESS_ROLE=voip` seleciona o processo de telefonia, portanto não há
uma segunda imagem para baixar ou versionar.

Não declare `entrypoint` ou `command` no container de telefonia ou nos demais
serviços ViperConnect. O entrypoint oficial da imagem reconhece
`UNOAPI_PROCESS_ROLE=voip` e inicia o processo correto; sobrescrevê-lo também
impede o desligamento gracioso do worker Zapo.

## Onde cada parte roda

Uma única imagem e tag contém dois runtimes Node isolados:

| Processo | Responsabilidade |
| --- | --- |
| worker Zapo | sessão, sinalização da chamada, relay WhatsApp, RTP/SRTP e codec |
| telefonia | SIP/WebRTC, SIP/RTP, ramais, roteamento, gravação e bridge PCM |

O worker usa `zapo-js`, o plugin VoIP mantido dentro do ViperConnect,
`libmlow-wasm` e um pequeno helper nativo para o relay direto. A telefonia usa
seu próprio `package.json` e `node_modules`; bibliotecas WebRTC desse processo
atendem os ramais no navegador e não transportam a mídia do WhatsApp.

O transporte de relay segue contratos públicos validados para chamadas 1:1,
mas a sessão e a sinalização pertencem integralmente à Zapo. Entre os dois
processos trafegam apenas comandos de chamada e PCM mono a 16 kHz pelo bridge
autenticado.

O relay WhatsApp suporta endpoints IPv4 e IPv6 em paralelo, com sockets
`udp4`/`udp6` explícitos. Essa família é independente do SIP/RTP do ramal: um
relay IPv6 pode alimentar um ramal IPv4 sem NAT64. O protocolo híbrido usa a
Zapo como dona da sessão, contratos públicos do Meow Caller como referência de
fio e extensões próprias do ViperConnect para bridge, codec, dual-stack,
recuperação e telemetria. Veja [VoIP dual-stack IPv4 e IPv6](/guide/voip-ipv6).

## Fluxo de chamada

1. A sessão Zapo abre o bridge autenticado após ficar online.
2. A Uno consulta primeiro o contato por `peerJid` e depois pelo telefone confirmado no diretório da própria sessão.
3. Uma chamada recebida gera `call.incoming` com `callerPn`, `callerName` e `callerNameSource` quando disponíveis, mas não é atendida automaticamente.
4. O serviço toca todos os registros livres do ramal automático e os destinos imediatos do roteamento avançado.
5. Somente o primeiro registro ou destino que atende dispara `call.command: accept`; as outras pernas são canceladas com `answered_elsewhere`.
6. A Zapo conclui a sinalização e abre a mídia da chamada atendida.
7. Áudio usa frames binários PCM Float32 mono a 16 kHz; nunca JSON, base64 ou RabbitMQ.
8. Encerramento em qualquer perna fecha WhatsApp, SIP e o stream daquela chamada.

O nome segue a prioridade `displayName`, `pushName`, `username` e, por último,
o telefone confirmado. A resolução nunca cruza empresas ou sessões. O
`display-name` SIP e o `remote_identity.display_name` do WebRTC recebem o nome
normalizado; a URI SIP continua usando o número. CR/LF e caracteres de controle
são removidos, e aspas são escapadas com segurança. Sem telefone confirmado, o LID fica
somente em `remoteJid` para auditoria e não é apresentado como número.

Se o WhatsApp entregar um `<reject>` estranho para uma chamada recebida, o
worker o ignora porque a sessão não foi a iniciadora. Rejeição de uma chamada
de saída continua normal, e o cancelamento remoto de uma entrada continua vindo
por `<terminate>`. Esse guard não altera o caminho de mídia.

Cada chamada é isolada por `session + callId`. Não existem slots ou seleção de
dispositivo no roteamento ativo. `maxConcurrentCalls` é a capacidade única da
linha Zapo, compartilhada por locks de entrada (`inbound_call`) e saída
(`outbound_line`). O encerramento libera somente o lock da própria chamada.

O padrão é 2 e o valor pode ser ajustado entre 2 e 32. Capacidade cheia
retorna `line_capacity_exhausted`, sem fallback. A variável
`VOIP_MAX_CONCURRENT_CALLS` define a capacidade anunciada pelo worker; mantenha
o valor igual ou acima do configurado nas linhas.

### Seleção manual da linha de saída

Cada linha pode receber um `outboundAccessPrefix` opcional no cadastro de
**Linhas Zapo**. O formato aceito é asterisco, de um a seis dígitos e outro
asterisco, por exemplo `*81*`. Prefixos não podem se repetir dentro da mesma
empresa.

Sem prefixo, o roteamento avançado mantém a ordem configurada nos grupos de
linhas. Para solicitar uma linha específica em WebRTC, MicroSIP ou outro ramal
SIP, coloque o prefixo antes do telefone:

```text
5566996269251       → seleção automática
*81*5566996269251   → solicita a linha cadastrada com *81*
```

Os gateways SIP/UDP e WebRTC preservam o prefixo (inclusive `%2A`) até a
validação do roteador. Uma discagem com prefixo não é tratada como ramal interno.
O prefixo é removido antes de enviar o número ao WhatsApp. Ele não concede
acesso adicional: a linha precisa pertencer às rotas de saída já autorizadas
para o grupo do ramal e à mesma empresa. Prefixo desconhecido é recusado; linha
fora da rota é recusada; linha escolhida offline ou sem capacidade também falha
sem cair silenciosamente para outra linha. Chamadas internas entre ramais
continuam sem linha externa quando não há prefixo.

### IA pós-chamada: Groq, OpenAI e OpenRouter

Em **Empresas → IA pós-chamada**, selecione separadamente o provedor de
transcrição e o de resumo: Groq, OpenAI, OpenRouter ou compatível/personalizado.
Os provedores conhecidos preenchem a URL; personalizado permite editá-la.
Configurações antigas sem provedor explícito continuam usando a URL salva.

Ao selecionar OpenRouter, o modelo vira um dropdown carregado do catálogo
atual: transcrição consulta `output_modalities=transcription`; resumo lista
modelos que recebem e produzem texto. O catálogo é público, não envia chave nem
gravação e não garante crédito ou disponibilidade para a sua conta. Se falhar,
a tela informa o erro e preserva o modelo salvo, sem selecionar outro silenciosamente.
Para Groq/OpenAI/personalizado, o ID do modelo permanece editável.

O botão **Atualizar catálogo de modelos OpenRouter** consulta novamente as duas
listas sem apagar a escolha ou a chave digitada. Um modelo salvo que saiu do
catálogo continua identificado como salvo, sem troca automática. Assim como no
Super Admin do ViperChat, o servidor valida novos modelos ao salvar: transcrição
exige entrada de áudio e saída de transcrição; resumo exige entrada/saída de
texto. Modelo incompatível retorna `422 invalid_openrouter_model`; catálogo
indisponível durante uma mudança retorna `502 ai_model_catalog_unavailable`.
Em ambos os casos a configuração anterior permanece intacta. Salvar outros
campos sem trocar modelos existentes não exige disponibilidade do catálogo.
Essa consulta externa não bloqueia a fila de configuração da telefonia. Uma
alteração concorrente da IA retorna `409 ai_configuration_changed`, pedindo
reabrir a empresa para não sobrescrever a configuração mais recente.

Informe a chave correspondente a cada provedor. Trocar a URL/provedor não
reutiliza o segredo antigo; campo vazio mantém a chave somente no mesmo endpoint.
A chave de transcrição pode servir ao resumo apenas quando ambos usam o mesmo
endpoint. Chaves são ocultadas nas respostas e no painel. Somente administradores
gerenciam essa configuração e consultam `GET /admin/voip/console/ai/models`.

OpenRouter recebe o áudio MP3/WAV como JSON base64 em `/audio/transcriptions`
e o texto em `/chat/completions`. Limite local conservador: 25 MiB por áudio.
Chamadas longas podem exceder limites/tempo do provedor; não há divisão automática.
Saldo insuficiente, modelo incompatível e outros erros seguem a fila/retry existente,
sem fallback para outro provedor. Áudio e transcrição saem do servidor para o
provedor escolhido: revise custos e política de dados antes de ativar.
Este recurso é pós-chamada; URA/agente de voz em tempo real permanece melhoria futura.

Referências: [transcrição OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/stt)
e [catálogo de modelos](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

### Completar DDI e DDD na saída

No cadastro da linha, `defaultDdi` e `defaultDdd` são sugeridos pelo número
brasileiro completo: `5566996269251` sugere `55` e `66`. Os valores são editáveis;
apagar e salvar mantém os campos vazios, sem restaurar a sugestão. Não há inferência
automática para outros países ou números incompletos.

No ramal, cada campo preenchido prevalece sobre o correspondente da linha
selecionada; vazio herda da linha. A seleção por prefixo ou pelo roteamento
avançado ocorre antes do complemento e continua respeitando permissões e capacidade.
Ramais internos não recebem complemento.

Com DDI `55` e DDD `66`, `996269251` vira `5566996269251`; números locais de
8 ou 9 dígitos exigem os dois padrões. Números de 10 ou 11 dígitos recebem apenas
o DDI. Números completos de 12 ou mais dígitos e internacionais com `+` não
recebem complemento. Para outros planos de numeração, disque o número completo
com `+`; as regras de comprimento são brasileiras e não removem código de operadora.
Os campos aceitam DDI de 1 a 3 dígitos e DDD de 2 a 4, sem zero inicial.
O editor usa as mesmas permissões de edição da linha ou do ramal.

Cada ramal também possui um **Modo de conexão SIP** independente da capacidade
da linha. **Ramal tradicional** permite uma chamada por registro conectado.
**Tronco SIP/PBX** permite vários diálogos pelo mesmo registro SIP/RTP, indicado
para Asterisk, FreePBX, Issabel e outros PABXs. O modo é explícito e nunca é
deduzido pelo `User-Agent`; configurações antigas permanecem como ramal
tradicional.

Em validação real de 2026-08-06, duas chamadas de saída simultâneas e duas
chamadas de entrada simultâneas foram mantidas na mesma linha, com áudio
bidirecional independente, encerramento normal e zero erro SRTP/Opus.

Se o número chamado também estiver conectado como sessão Zapo nesta instalação,
o WhatsApp gera uma perna recebida espelhada com o mesmo `callId`. Ela é
observada, mas não abre outro ramal, stream, gravação ou histórico. A perna de
saída continua sendo a dona da ponte de áudio, como numa chamada externa.

## API administrativa

Todas as rotas abaixo passam pela Uno e usam a mesma autenticação
administrativa da API. O navegador não recebe `VOIP_SERVICE_TOKEN`.

### Estado, chamadas e transferência

**Correção integrada à 4.0.37 / VoIP 0.1.67:** quando o REFER chega de
outro IP por mudança de caminho NAT, as tags do diálogo não bastam: o servidor
solicita autenticação Digest (`401` / `WWW-Authenticate`) do ramal de origem.
O cliente precisa reenviar o REFER autenticado, com Request-URI/realm corretos,
nonce válido e contador não reutilizado. Só então o peer do diálogo é atualizado.
Origem desabilitada, senha de outro ramal e tags inválidas continuam bloqueadas.
Mudança apenas de porta no mesmo IP mantém o comportamento anterior.
Não há liberação por subnet, Via ou Contact informado. Clientes sem suporte a
Digest no REFER não transferem por esse caminho. A correção está incorporada
ao código-fonte; em 2026-10-13 o usuário validou a transferência 1001 → 1010
na VPS com o hotfix temporário, no cenário de destino registrado com IPv6.
Publicar a tag aciona o build; não atualiza a VPS. Na atualização, retirar o host path
temporário para não sobrepor o código da imagem.

Release unificado: ViperConnect `4.0.37` com VoIP `0.1.67`, revisão
`9615a6f78582fb84a9f10647f98744cc41e1befe` fixada no workflow de imagem.

O áudio MP3/WAV enviado no grupo de ramais é reproduzido para o participante
WhatsApp enquanto o destino da transferência toca. Vale primeiro o grupo
habilitado da origem com áudio; depois o grupo do destino, na mesma empresa.
Entre vários grupos elegíveis, vale a ordem da configuração. O microfone da
origem é suspenso apenas durante a reprodução; outras chamadas não são afetadas.
O áudio repete até atender, recusar todos os destinos, atingir o timeout de
30 segundos ou encerrar a chamada. O CANCEL SIP preserva o destino exato do
INVITE, incluindo porta e parâmetros, para cancelar também o toque pendente.

O upload exige a autorização VoIP e o escopo da empresa já usados no console.
O worker precisa de ffmpeg e acesso ao arquivo persistido; falhas de decodificação
geram aviso sem silenciar a chamada original. São decodificados até 300 segundos
do arquivo. Isso não implementa URA, agente de voz ou transferência assistida.
Após atualizar, valide no aparelho tanto a audição durante a espera quanto o
fim do toque ao desligar no WhatsApp.

- `GET /admin/voip/bootstrap`: retorna configuração, linhas Zapo, chamadas,
  reservas, registros SIP/WebRTC, histórico inicial e resumo de armazenamento;
- `GET /admin/voip/calls`: lista chamadas ativas;
- `POST /admin/voip/calls`: inicia chamada com `session`, `peerJid` e
  `extensionId`;
- `POST /admin/voip/calls/{callId}/{command}`: executa `accept`, `reject`, `end`
  ou `mute`;
- `POST /admin/voip/console/calls/{callId}/transfer`: transfere uma chamada
  ativa para `targetExtensionId`.

### Cadastro de linhas e sessões Zapo

- `GET /admin/voip/console/{resource}`: lista `companies`, `accounts`,
  `lineGroups`, `extensionGroups`, `sessions` ou `extensions`;
- `PUT /admin/voip/console/{resource}/{id}`: cria ou atualiza o recurso;
- `DELETE /admin/voip/console/{resource}/{id}`: remove o recurso;
- `GET /admin/voip/console/zapo-lines`: lista as linhas descobertas pela bridge;
- `POST /admin/voip/console/zapo-lines/{session}/assign`: altera posteriormente
  a empresa de uma linha já provisionada. `createBasicRoute` está depreciado e
  não controla mais a criação do ramal.

A sessão Zapo já é a origem da telefonia e não exige cadastro de dispositivo,
QR code, ativação manual ou seleção adicional. No bootstrap, conexão,
`session.status` e reconexão, a Uno garante automaticamente empresa, linha,
sessão de telefonia e ramal com usuário igual ao número da sessão. A empresa já
vinculada é preservada; depois é considerada a empresa da conta/linha e, por
último, `empresa-padrao`, criada quando necessário. Recursos gerenciados usam
`provisioningSource=zapo_auto`.

O bootstrap expõe em cada linha:

```json
{
  "automatic": {
    "extensionId": "ext_5566999554300",
    "username": "5566999554300",
    "status": "active",
    "registrationCount": 3,
    "freeRegistrationCount": 2,
    "busyRegistrationCount": 1,
    "transports": ["sip", "webrtc"],
    "basicInboundEnabled": true
  },
  "advancedRoutingConfigured": true
}
```

Após 60 segundos offline, o ramal automático é desativado, ocultado e seus
registros são encerrados. A reconexão reativa o mesmo ID, usuário e senha. Cada
linha possui `maxConcurrentCalls` de 2 a 32, compartilhado entre entrada e
saída. Configurações antigas com slots podem ser lidas uma vez para migrar a
capacidade, mas esses campos não participam do roteador ativo e o Manager não os
cria nem edita.

### Ramais, registros e roteamento

- `GET /admin/voip/console/extensions/{extensionId}/credentials`: retorna ao
  administrador usuário, senha, URI SIP e parâmetros WebRTC do ramal;
- `DELETE /admin/voip/console/extensions/{extensionId}/registrations/{registrationId}`:
  desconecta um registro ativo; use `type=webrtc` ou `type=sip_rtp` para limitar
  o transporte;
- `GET /admin/voip/console/extensionGroups/{extensionGroupId}/transfer-audio`:
  reproduz o áudio de transferência configurado;
- `PUT /admin/voip/console/extensionGroups/{extensionGroupId}/transfer-audio`:
  envia MP3 ou WAV binário, com até 15 MB, e aceita o nome em `X-File-Name`;
- `POST /admin/voip/console/router/resolve-inbound`: simula entrada com
  `sessionId` e `callId` opcional;
- `POST /admin/voip/console/router/resolve-outbound`: simula saída com
  `extensionId`, `target` e `callId` opcional;
- `GET /admin/voip/console/router/locks`: lista reservas ativas;
- `DELETE /admin/voip/console/router/locks/{lockId}`: libera uma reserva;
- `DELETE /admin/voip/console/router/calls/{callId}/locks`: libera todas as
  reservas pertencentes a uma chamada.

Ramais podem pertencer a vários grupos. `extensionGroupDistances` define a
prioridade numérica de cada grupo no roteamento: menor distância toca primeiro.
O simulador aplica as mesmas regras reais, mas não abre a chamada.

Por padrão, o ramal automático toca junto com os destinos avançados imediatos;
regras com atraso mantêm seu tempo e um ramal repetido é deduplicado. Em uma
sessão avançada, `routing.basicInboundEnabled=false` corresponde a **Desativar
atendimento básico**: somente a entrada automática deixa de tocar, enquanto o
ramal continua registrado e pode originar chamadas. A opção exige um destino
avançado válido; ao remover o último destino, o básico é reativado.

### Histórico, gravações e IA

- `GET /admin/voip/console/history`: filtra por `page`, `pageSize` (máximo 100),
  `search`, `startDate` e `endDate`; a busca inclui nome e número do contato;
- `GET /admin/voip/recordings/{recordId}`: reproduz ou baixa uma gravação pela
  fachada autenticada da Uno;
- `GET /admin/voip/console/recording/summary`: resume arquivos e bytes por linha;
- `GET /admin/voip/console/recording/settings`: consulta a configuração sem
  devolver segredos;
- `PUT /admin/voip/console/recording/settings`: configura disco local ou S3
  compatível, formato, estéreo, retenção e URLs assinadas;
- `DELETE /admin/voip/console/recording/accounts/{accountId}`: remove as
  gravações armazenadas da linha e retorna `deleted` e `bytes`.

Na retenção, `0` desativa a exclusão automática. Um valor maior remove apenas
a mídia local ou S3 que esteja finalizada, com status `available`, e cuja data
de término seja anterior ao corte. A limpeza roda ao iniciar o serviço, a cada
6 horas e depois de salvar a configuração. O histórico da chamada é mantido e
somente os campos da gravação são limpos; uma falha no storage preserva esses
campos para nova tentativa. O intervalo pode ser ajustado no serviço VoIP com
`VOIP_CALL_RECORDING_RETENTION_CLEANUP_INTERVAL_MS`.

A página **Telefonia** do Manager usa abas, grids e modais para empresas,
linhas, ramais e **Roteamento avançado**. O grid de ramais distingue
**Automático** de **Avançado** e oculta automáticos offline por padrão.
**Chamadas e gravações** ficam numa
única aba: chamadas ativas, histórico, player, download, configuração e resumo
de armazenamento usam o mesmo fluxo, sem repetir filtros ou registros. O serviço
VoIP não possui frontend nem usuários administrativos próprios; a Uno é a
interface única. O JSON interno não é exposto como editor de configuração.
Segredos já configurados aparecem apenas como indicadores e são preservados
quando o campo secreto não é reenviado.

Não existe estado **Aguardando empresa** nem botão **Ativar linha**. O
provisionamento é idempotente, preserva empresa, senha, Chatwoot, IA, grupos e
rotas existentes e usa o número da sessão como usuário. O administrador usa
**Credenciais** no grid de ramais para recuperar SIP e WebRTC e selecionar
**Ramal tradicional** ou **Tronco SIP/PBX**. No automático, somente esse modo é
alterado; identidade, senha, empresa e vínculos continuam gerenciados.

O mesmo ramal pode ser registrado em vários telefones SIP e navegadores WebRTC.
Todos tocam na chamada recebida; o primeiro que atende fica com a chamada e as
outras pernas são canceladas como atendidas em outro lugar.

Cada empresa pode configurar transcrição e resumo pós-chamada por IA. URLs,
modelos, idioma, prompt e a inclusão da transcrição são editáveis no Manager;
tokens já salvos não voltam para o navegador e um campo secreto vazio preserva
o valor existente. A configuração fica em `companies/{id}` dentro de
`aiSummary`, mantendo cada empresa isolada.

Cada linha também pode encaminhar a gravação ao Chatwoot. A opção
`chatwootRecording.privateNote` controla se o anexo entra como nota privada, e
o token salvo segue a mesma regra de preservação de segredo.

No histórico, gravações com estado `available` possuem os botões **Reproduzir**
e **Baixar**. A reprodução acontece em um player de áudio dentro do próprio
grid; a coluna **Contato** mostra `remoteName · remoteNumber`, e `remoteJid` e
`remoteNameSource` preservam a fotografia auditável do início da chamada. O
Chatwoot continua procurando conversas pelo número, nunca pelo nome, e a IA
recebe nome e número como contexto quando disponíveis. O processamento da IA é
configurado por empresa e independe do Chatwoot; quando ambos estão ativos, a
publicação da nota é opcional e não bloqueia a transcrição nem o resumo. O
histórico possui busca, período e paginação. O navegador recebe o áudio
pela fachada autenticada da Uno e nunca conhece o token interno do serviço VoIP.
O Manager também mostra quantidade e tamanho por linha e exige confirmação
antes da limpeza em lote.

## Eventos de chamadas no ViperChat

No Manager, um administrador abre **Telefonia → Empresas → Editar** e configura
**Eventos de chamadas no ViperChat**. Esse cadastro é independente de gravações
no Chatwoot. Informe URL base HTTPS, ID da conta, ID do serviço VoIP cadastrado
no ViperChat, identificador estável da origem e `api_access_token` de um usuário
administrador dessa conta. O identificador deve coincidir nos dois sistemas.

O segredo é somente de escrita: nunca é preenchido novamente na tela nem
retornado pelo proxy. Campo vazio preserva o token; **Remover o token salvo**
exige desativar o envio junto da remoção. Usuários comuns do Manager não podem
ler nem alterar essa configuração, mesmo tendo acesso à linha.

O formulário envia `viperchatWebhook` à rota administrativa existente de empresas.
Somente os ramais comprovadamente vinculados à empresa participam desse envio;
chamadas internas não dependem de uma linha WhatsApp. Participantes de outras
empresas ou desconhecidos não herdam essa autorização. A configuração antiga
do webhook por linha permanece protegida para compatibilidade, sem uso automático.
O serviço entrega snapshots ao endpoint
`/api/v1/accounts/{accountId}/voip/services/{serviceId}/events`, com cabeçalho
`api_access_token`. Não é Bearer, token interno VoIP, áudio ou AMI.
HTTPS é obrigatório; HTTP em loopback só é aceito em desenvolvimento.

O runtime do serviço precisa de SQLite persistente, RabbitMQ existente e
`VOIP_WEBHOOK_AMQP_ENABLED=true`, `VOIP_AMQP_URL` configurado com credenciais
do broker e, opcionalmente, `VOIP_WEBHOOK_QUEUE_PREFIX` e
`VOIP_WEBHOOK_MAX_ATTEMPTS`. Não exponha esses segredos no navegador.
Outbox transacional, publicação confirmada, ACK manual, retentativas com atraso
e fila de falhas protegem a entrega. Eventos repetidos são idempotentes.
A ativação não reenvia automaticamente todo o histórico anterior.

Salvar no Manager não instala nem habilita o receptor no ViperChat: as migrações,
worker e configuração do serviço de destino também devem estar ativos.
Recuperação REST agendada/checkpoint e notificações nativas CallKit/Android
continuam etapas separadas; webhook não registra um ramal nem muda o áudio.

Em **Envio de gravação e IA**, selecionar `legacy` mantém a integração antiga por
caixa de entrada. Selecionar `webhook` usa o processador ViperChat e desativa
efetivamente os dois publicadores antigos (gravação e nota de IA), inclusive
jobs pendentes, sem apagar token, caixa ou preferências legadas. A IA continua
sendo gerada e armazenada. Não há publicação simultânea nem fallback silencioso.

O evento `call.artifacts.updated` leva metadados e referência autenticada do áudio,
transcrição/resumo e prova numérica do destino. O ViperChat mantém uma nota
privada por chamada na conversa comprovada, respeita caixas parceiras WhatsApp oficial/
ViperConnect, deduplica anexo/nota e apresenta os artefatos junto do histórico.
Sem conversa inequívoca, conserva pendência em vez de criar conversa vazia ou
publicar na caixa errada. Não reabre atendimento nem envia mensagem pública.

Consulte o [contrato completo de envio VoIP](/guide/voip-webhooks), incluindo
todos os campos, opções, eventos, estados, JSONs, respostas HTTP, segurança,
retentativas e limites de compatibilidade.

### Diagnóstico e reprocessamento administrativo

Em **Empresas → Editar → Diagnóstico de entregas ao ViperChat**, o administrador
consulta contagens, estado, tentativas, próxima tentativa e motivo técnico de
cada evento. Não são exibidos payload, telefone, áudio ou credenciais. O painel
consulta até 50 entregas recentes; **Atualizar** refaz a consulta.

**Reprocessar evento** só aparece para pendente/falha definitiva com destino
original ainda compatível. Uma confirmação explica o escopo e precisa ser aceita.
O servidor verifica novamente empresa, evento, estado e destino e agenda o mesmo
evento sem mudar conteúdo, IDs ou tentativas. Não reenvia eventos entregues,
não redireciona a outra empresa e não usa parâmetros de destino no corpo.
`requestId` UUID torna a repetição do mesmo pedido idempotente. Conflitos retornam
409 e precisam de nova análise, nunca ampliação automática de escopo.
