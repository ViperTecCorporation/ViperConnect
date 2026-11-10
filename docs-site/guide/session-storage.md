# Armazenamento por sessão: Redis e SQLite

O armazenamento por sessão separa o **plano de dados local** do **plano de
controle compartilhado**. O objetivo é retirar mensagens e estado persistente
da memória do Redis sem alterar os IDs públicos das mensagens.

Esta implementação está em validação no desenvolvimento. Publicar código ou
documentação não migra as sessões de produção. Não há failover automático de
um arquivo SQLite local para outro servidor.

## Explorar e manter os dados da sessão

Para a base de telefonia, use o fluxo separado de
[backup e restauração VoIP](/guide/voip-backups). `.viperstorage` é da sessão
WhatsApp; `.vipervoip` é da base/configuração e áudios de espera do VoIP.

Em **Gerenciar sessão → Visão geral → Armazenamento**, o administrador encontra
**Explorar SQLite** e **Redis da sessão**. O primeiro acessa o arquivo no worker
dono; o segundo abre o explorador Redis existente com o número pré-selecionado.
Não são duas cópias: os dados migrados ficam no SQLite; coordenação permanece no Redis.

No SQLite, selecione a tabela e consulte chaves/identificadores. Expanda um
registro para visualizar o conteúdo. A busca é paginada e pode exigir **Continuar
busca** mesmo quando a página estiver vazia. Não faz busca no texto de mensagens.
Mostra dados persistidos, inclusive registros expirados ainda aguardando limpeza.

**Criar registro**, **Editar** e **Excluir** são operações reais no banco, não no
WhatsApp. Exigem sessão offline, reconexão automática desativada, confirmação e
backup S3 verificado antes de cada alteração. Não desconectam a sessão sozinhas.
Sem backup confirmado não há escrita. Conflitos de geração, lease ou conteúdo
modificado são recusados; não há repetição automática. Consulte o banco após um
timeout antes de tentar novamente. Um backup anterior é identificado na resposta.

O editor usa JSON de campos: texto, número ou `null`; BLOB aceita
`{"utf8":"valor"}` ou `{"base64":"..."}`. Campos omitidos são preservados ao editar.
Os pares UnoID ↔ provider ID são alterados juntos em transação; conflitos são recusados.
Uma alteração manual incorreta em dados de mensagem pode afetar histórico/cache;
o backup permite voltar ao estado anterior pelo fluxo normal de restauração offline.

Não há SQL livre, DDL ou edição de tabelas internas/credenciais criptográficas.
Essas tabelas aparecem protegidas no catálogo. Segredos e URLs de mídia são
ocultados; protobuf de mensagem tem prévia pública, não exportação dos bytes.
Campos acima de 64 KiB não são editáveis pelo explorador. Somente login de
administrador: usuários comuns e chaves API/pessoais são recusados.

Rotas: `GET /v15.0/{phone}/storage/explorer` e `POST` no mesmo caminho
(`action=create|update|delete`, `table`, `generation`, `confirm=true`; edição/exclusão
exigem `rowId` e `etag`). Até 50 resultados e 200 registros examinados por página;
cursor vinculado a sessão/banco/geração/tabela/busca. O web não abre o volume local.

## Padrão e dependência do Redis

**Novas sessões usam SQLite por padrão, na raiz `/app/session-data`, somente
quando o worker confirma um volume persistente montado e gravável e um motor
SQLite compatível.** Sem esse volume, o fluxo tradicional Redis continua
funcionando e o painel mostra um alerta com instruções. As ENVs abaixo são
opcionais; declarar uma ENV ou criar uma pasta no container não substitui o volume.

| Configuração | Comportamento quando não declarada |
| --- | --- |
| `SESSION_STORAGE_DEFAULT` | Solicita `sqlite` para novas sessões; sem capacidade válida usa Redis. Defina `redis` para manter o padrão antigo mesmo com volume válido. |
| `SESSION_STORAGE_PERSISTENT` | Detecta o mount real e testa escrita. `true` não ignora essa verificação; `false` desabilita SQLite. Mounts tmpfs/ramfs/overlay não são aceitos. |
| `SESSION_STORAGE_ROOT` | Usa `/app/session-data`. Pode apontar para outro caminho persistente montado no worker; não herda `UNOAPI_BASE_STORE`. |

**Redis continua obrigatório mesmo com SQLite ativo. Não remova o serviço
Redis nem a configuração `REDIS_URL`.** SQLite guarda os dados locais da
sessão; Redis mantém catálogo, configuração, autenticação/permissões do painel
e da API, worker dono, leases,
locks, roteamento e invalidações compartilhadas. SQLite não substitui Redis,
RabbitMQ ou S3. A recuperação sem o catálogo anterior também precisa de um
Redis de destino acessível; não é operação normal sem Redis.

- Sessão Redis existente continua no fluxo Redis; ativar o padrão SQLite não
  a migra automaticamente.
- Nova sessão sem SQLite configurado, ou com volume/capacidade inválidos, usa
  Redis após confirmação do worker e mostra o aviso de configuração.
- Timeout ou falha do worker não confirma fallback: a seleção nova ainda não
  confirmada fica pausada com erro explícito, sem criar banco vazio.
- Sessão **já migrada para SQLite** continua no SQLite mesmo se a ENV de
  padrão for removida. Volume ausente retorna erro: não volta ao Redis antigo,
  não mescla dados e não recria banco vazio.

Essas regras descrevem a nova arquitetura por sessão na stack Redis-backed,
não os antigos modos standalone/file com `useRedis=false`. A verificação do
motor pode abrir e fechar um SQLite temporário `:memory:` para conferir a API
e a versão; isso não cria arquivo nem transfere os dados da sessão para SQLite.

## Como ativar SQLite

Adicione o volume persistente ao **serviço atual do worker Zapo**, preservando
imagem, redes, variáveis e mounts existentes. As três variáveis abaixo apenas
explicitam os padrões; podem ser omitidas ao montar em `/app/session-data`:

```yaml
services:
  worker-zapo:
    environment:
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
      SESSION_STORAGE_DEFAULT: sqlite
    volumes:
      - session-data:/app/session-data
volumes:
  session-data: {}
```

Este é um fragmento, não um Compose completo. Preserve o `UNOAPI_SERVER_NAME`
explícito e estável do worker dono; não troque o dono da sessão nem substitua
um volume que já contenha bancos. Se já houver uma raiz persistente, mantenha
o caminho e o mount correspondentes em vez de criar outro volume vazio.
Aplique a configuração ao worker e confira sua capacidade no painel. Preserve
também o serviço Redis e sua `REDIS_URL`, mesmo com as três ENVs acima.

Administrador: **Sessão → Visão geral → Armazenamento da sessão**:

- **SQLite indisponível neste worker.** Abra **Como configurar** para ver o
  motivo e o exemplo de volume/configuração. Declarar persistência na ENV não
  substitui um volume realmente montado, gravável e validado pelo worker.
- **SQLite disponível, mas novas sessões ainda usam Redis.** Abra **Como ativar
  SQLite** e aplique `SESSION_STORAGE_DEFAULT=sqlite` ao worker, preservando
  volumes e dono. Esse aviso aparece quando o padrão foi explicitamente mantido em Redis.

O padrão vale apenas para **novas sessões** QR e Mobile Primary. Sessões
existentes usam **Migrar para SQLite**, com confirmação manual. Sessões já
migradas permanecem SQLite; volume ausente ou inválido deve retornar erro
explícito, nunca criar banco vazio ou voltar silenciosamente ao Redis.

## Configuração obrigatória do worker

### Segurança do laboratório: modo sintético e modo normal

No `compose.lab.yml`, `LAB_STORAGE_SYNTHETIC_ONLY` é `true` por padrão e controla
`UNOAPI_STORAGE_SYNTHETIC_ONLY` nos processos do laboratório. A barreira global
impede efeitos externos durante testes de armazenamento com dados sintéticos.

Para testar uma sessão real autorizada no DEV, revise antes as sessões e remova
as cópias de produção importadas para ensaios, com escopo exato e autorização.
Somente depois, configure `LAB_STORAGE_SYNTHETIC_ONLY=false` no arquivo ENV
**privado** usado pelo laboratório e aplique a configuração aos processos
envolvidos. Não publique esse arquivo nem seus segredos. O opt-in desativa a
barreira global do DEV, não permissões, confirmações ou proteções por sessão.

Uma sessão marcada como `sessionStorage.fixture=true` continua impedida de
conectar, enviar ou baixar mídia real mesmo no modo normal. Não remova essa
marcação para conectar uma cópia de produção; ela deve ser retirada do ambiente
de teste antes de liberar contas normais. Alterar o modo não migra dados, não
reativa sessões suspensas e não autoriza envio de mensagens de teste.

### Volume persistente

SQLite exige volume persistente disponível no worker responsável,
conforme o fragmento em [Como ativar SQLite](#como-ativar-sqlite).

`SESSION_STORAGE_ROOT` identifica a raiz local; `SESSION_STORAGE_PERSISTENT=true`
declara a intenção de persistência, mas não substitui a verificação do volume.
`SESSION_STORAGE_DEFAULT=sqlite` é o padrão para novas sessões **somente
quando o worker confirma a capacidade**. Sem volume/capacidade válida,
novas sessões permanecem Redis e o painel mostra o motivo e um exemplo de ajuste.
Sessões já migradas cujo volume desapareceu devem falhar explicitamente:
**não** criar um banco vazio nem voltar ao Redis silenciosamente.

### Novas sessões, antes de conectar

O cadastro QR é preparado em duas fases: primeiro persiste a configuração com
`autoConnect=false` e um identificador de tentativa; depois pede ao worker dono
que prepare o backend. A conclusão exige um recibo persistido da **mesma
tentativa e do mesmo dono**, com backend e, no SQLite, UUID e geração do banco.
Só então restaura a intenção de conexão e publica o reload. Sem volume válido,
o worker pode confirmar Redis explicitamente; timeout não confirma fallback.

Uma resposta RPC perdida pode ser confirmada pelo recibo já persistido, tanto
para SQLite quanto para Redis escolhido intencionalmente. Sem esse recibo, o
register retorna `session_storage_provision_unconfirmed` (503) e mantém a sessão
suspensa. Repetir o register retoma a tentativa pendente; não troca um SQLite
confirmado por Redis nem inicia um banco vazio. Alterações concorrentes são
comparadas antes de confirmar, sem substituir configuração mais recente.

O Mobile Primary prepara o armazenamento **antes** de reservar a sessão para
importar auth. Durante a importação, mantém a sessão suspensa e renova sua
reserva a cada 15 segundos, com validade de 60 segundos. Só habilita a conexão
após conferir as credenciais e confirmar, atomicamente, configuração, dono,
reserva e registro do dispositivo. Repetir a operação não sobrescreve auth já importado ou
chaves atualizadas. Cadastro parcial antigo sem seleção de armazenamento
retorna `mobile_storage_selection_required` (409), preservando os dados para
conferência. Em primários já importados, a reconexão usa o descritor atual do
banco após migração ou restore, não um recibo antigo de criação.

Sessões antigas não são migradas por esse padrão. Ao reiniciar, o worker não
cria clientes vazios para sessões QR ou primárias suspensas; isso mantém backup
e restore offline disponíveis.

As rotas antigas `/connect/{phone}`, `/sessions/{phone}` e
`POST /{phone}/request_code` não cadastram um telefone implicitamente. Na stack
Redis-backed, um telefone sem configuração persistida retorna HTTP 409
`session_storage_registration_required`. Faça primeiro
`POST /v15.0/{phone}/register` e aguarde a confirmação do backend pelo worker;
depois utilize a rota de conexão/pareamento. Isso impede iniciar um store Redis
por fora da escolha SQLite. Sessões Redis e SQLite já cadastradas mantêm seu
backend e o comportamento de conexão existente.

Configuração, worker, UUID, geração e recibos internos não são atalhos de
migração: os campos internos são somente de leitura na API. O Commander também
recusa alterações de motor, dono ou controles de armazenamento/dispositivo.
Atualizações comuns comparam a configuração vigente antes de gravar e preservam
edições compatíveis; alterações incompatíveis com migração, importação ou outra
edição retornam conflito, sem restaurar um descritor antigo. Mudanças reais de
intenção de conexão não são descartadas pelo debounce: o reload é serializado
por sessão, com uma única inicialização
do cliente por vez.

O volume deve sobreviver à recriação do container. Não utilizar diretório
temporário, pasta sincronizada pelo Nextcloud ou arquivo SQLite compartilhado
por NFS/SMB entre workers. O identificador do storage é estável e separado do
telefone e da geração do vínculo WhatsApp.

## O que fica em cada armazenamento

| SQLite local da sessão | Redis compartilhado |
| --- | --- |
| Store persistente da Zapo, mensagens, contatos e histórico | Catálogo da sessão, localização do dono e geração |
| Cópias ViperConnect, UnoID ↔ provider ID, chaves e estados | Leases, locks, roteamento e invalidações |
| Índices, metadados e caches locais selecionados | Autorização, destinos de webhook, circuit breaker e coordenação |

### O que continua no Redis

**SQLite reduz os dados de sessão na RAM, mas não elimina o Redis da stack.**
Para uma sessão migrada, continuam compartilhados no Redis:

- **Cadastro e configuração:** número, worker responsável, backend, geração,
  opções e metadados de registro/dispositivo. As credenciais WhatsApp do store
  Zapo ficam no SQLite; não se confundem com esses controles.
- **Acesso ao sistema:** usuários, tokens, permissões do painel/API e índices
  de autorização.
- **Coordenação:** estado online/offline, leases de conexão, locks de tarefas,
  roteamento RPC e notificações/invalidações entre processos. Esses controles
  impedem, por exemplo, dois workers de assumirem a mesma sessão.
- **Webhooks:** destinos, controles de entrega e circuit breaker. As filas de
  mensagens da stack continuam no RabbitMQ, não são transferidas para SQLite.
- **Backups:** catálogo, agenda, reservas e acompanhamento das tarefas. Os
  arquivos de backup e manifestos ficam no S3; o catálogo Redis não é o arquivo.
- **Controles compartilhados:** limites de envio, contadores e índices globais.

### Recursos de sessão que ainda usam Redis

Além dos controles acima, a implementação atual ainda mantém:

| Recurso | Persistência atual e limite |
| --- | --- |
| Blacklist de contatos/webhooks | Chaves `unoapi-blacklist:{sessao}:{webhook}:{destino}`, com bloqueio/remoção e TTL no Redis. Os contatos usados para resolver telefone/LID podem estar no SQLite, mas o bloqueio não está. |
| Campanhas | Índices e registros de agendamento `bulk-index`/`bulk-message` no Redis. O relatório consulta o status da mensagem no backend da sessão. |
| Temporizadores de interação | Registros `unoapi-timer:{sessao}:{destino}` no Redis. Não fazem parte das famílias migradas. |

Esses recursos **não devem ser apresentados como já migrados para SQLite**.
Uma futura mudança precisa tratar os consumidores e a coordenação entre
processos, preservar TTL e incluir migração/testes; não basta mover as chaves.

O backup `.viperstorage` **não inclui a blacklist, os índices/agendamentos de
campanhas ou esses temporizadores**. Restaurar apenas esse arquivo não recupera
esses registros; preserve também o [backup global Redis](#backup-global-redis-para-s3).
Ele inclui dados das sessões que ainda usam Redis, além dos controles globais.
Ativar SQLite como padrão não migra automaticamente sessões Redis existentes.

Os arquivos de mídia permanecem no media storage configurado, por exemplo S3;
o banco guarda as referências necessárias. Não mover chaves globais apenas
porque contêm um telefone: mapeamentos globais e contadores compartilhados têm
consumidores em vários processos.

A API e o broker consultam o worker responsável inclusive com a conexão
WhatsApp offline. Worker/volume indisponível retorna erro; outro processo não
abre um banco novo para simular uma sessão vazia. Redis continua obrigatório
para coordenação, mesmo quando a sessão usa SQLite.

No Mobile Primary, a preparação de novas sessões acontece antes de importar
as credenciais: o cadastro fica pausado, o worker escolhe o backend conforme a
capacidade e só então recebe a importação. Para sessões SQLite, o processo HTTP
não abre o arquivo do worker; leitura/gravação de auth passam pelo RPC interno,
sem retornar credenciais ao navegador ou registrá-las nos logs. A leitura de
histórico para dispositivos vinculados usa índices SQLite locais em páginas,
preservando IDs, exclusões e expiração. Metadados de registro/dispositivo e
coordenação continuam separados no Redis; o backup deve contemplá-los também.
Os testes sintéticos dessa integração não comprovam vínculo real no aparelho.

Contatos usados pelo broker, pela resolução de telefone/LID da blacklist e pelo
contexto de Status são consultados no worker responsável; isso não transfere os
bloqueios da blacklist para SQLite. O processo web não abre o SQLite local. A sincronização
percorre páginas limitadas de contatos nativos e referências locais, respeita
expiração e evita repetir o mesmo telefone, sem adivinhar PN a partir do LID.
Recibos, edições e status de saída atualizam projeções no banco da sessão,
preservando a ordem dos status e a expiração anterior. O estado `sent` é gravado
após o ACK do provedor mesmo sem webhook configurado. Se essa gravação falhar,
a repetição da tarefa pode repará-la usando IDs e chave já persistidos, sem
novo envio; isso não reconstrói mapeamentos ausentes nem comprova `delivered`
ou `read`. A atualização em tempo real usa Redis apenas
como barramento de invalidação: telefone, conversa, ID e estado público seguro,
sem corpo de mensagem, mídia ou credenciais. A autorização da assinatura é
conferida novamente antes de cada evento ao navegador.

Os índices locais de username → LID e de destinatários de Status também seguem
o backend da sessão. Hashes, conjuntos ordenados e caches de fotos selecionados
não devem reaparecer no Redis após a migração; as operações remotas usam um
protocolo interno limitado ao telefone e às famílias de dados permitidas.

A mídia da aba Mensagens mantém a rota existente e aceita ID do provedor ou
seu alias UnoID, tanto em Redis quanto em SQLite. O alias exige mapeamento
recíproco válido da **mesma sessão**; referência ausente ou expirada não é
reconstruída por varredura. Mapeamento inconsistente retorna erro explícito.
Conteúdo removido, expirado ou de visualização única é bloqueado pelos dois
IDs antes de reutilizar o cache. No SQLite, o worker dono consulta o registro
local e reutiliza o objeto S3. Em falta de cache, usa o download
oficial Zapo por stream para o S3 já configurado; o RPC transporta somente a
chave interna, tipo MIME e nome. O processo HTTP entrega os bytes pelo storage
compartilhado, sem abrir o banco do worker. Sem S3 compartilhado, retorna
`session_storage_media_requires_shared_s3`; fixtures não fazem download.
Consultas simultâneas pelos dois IDs compartilham o download, sem reenviar a
mensagem. A rota não recebe um identificador adicional de conversa.

Tarefas de vídeo revalidam dono, backend e geração antes de acessar a mídia e
antes de devolver o trabalho à fila. Fixtures, o modo sintético e transições
`migrating`/`restoring` impedem esses efeitos. Isso não transforma
`autoConnect=false`, isoladamente, em bloqueio geral de processamento de vídeo.

Ao remover um vínculo SQLite, as credenciais e os caches nativos de conexão
são limpos, mas histórico, contatos, UnoID ↔ provider ID e arquivo permanecem.
A configuração recebe um marcador interno de desvinculação; somente nesse
estado offline, sem conexão automática e sem primário ativo, um novo register
pode trocar o perfil QR ou o tipo de pareamento. O marcador não pode ser enviado
pela aplicação e não autoriza trocar worker/provedor. Na remoção completa de um
Mobile Primary, a limpeza roda no dono e a finalização remove o registro de
dispositivo e desvincula a configuração preservada por CAS com geração e lease.
Suspender a integração de um primário continua sendo uma operação distinta.

## Migração manual no painel

Administrador: **Sessão → Visão geral → Armazenamento da sessão → Migrar para
SQLite**. O painel consulta capacidade e proprietário antes da confirmação.

Não migre durante uma ligação. O worker fecha a admissão de chamadas e verifica
chamadas ativas ou operações VoIP em andamento **antes de desconectar**. Se
houver chamada iniciando, tocando, conectada ou aguardando, a tarefa falha com
`session_storage_active_calls` (409), sem encerrar a ligação, copiar dados ou
alterar o backend. A admissão é reaberta quando a tentativa é recusada. Durante
uma migração admitida, novos comandos de chamada são recusados explicitamente;
não existe transferência de uma chamada em andamento entre stores.

1. A tarefa reserva a sessão, fecha a entrada de novos trabalhos e aguarda os
   eventos já aceitos, inclusive seu processamento de mídia com o socket ainda
   disponível. Só então desconecta o transporte, sem logout remoto.
2. Após revalidar configuração e geração, marca a transição e copia os dados
   para um banco preparado no seu volume, preservando
   bytes, autores, conversas, IDs e datas de expiração.
3. Valida integridade e publica o catálogo do novo storage com nova geração.
4. Faz backup `.viperstorage` sem criptografia no S3 e verifica o objeto por leitura de volta,
   restauração temporária, hash e integridade SQLite.
5. Ainda offline e sob a mesma lease, remove as chaves Redis de origem que
   continuam iguais ao snapshot. Configuração, locks e coordenação permanecem.
6. Somente a tarefa concluída confirma a migração. Aceite HTTP não é conclusão
   nem confirmação de conexão/entrega no WhatsApp.

Migração, restore, logout e reload compartilham a exclusão por sessão. Pedidos
conflitantes retornam erro explícito, não executam limpeza de auth nem apagam a
lease de outra tarefa. A conexão relê a configuração após operações assíncronas
e revalida geração e posse antes de abrir o socket. Se o drain falhar ou não
terminar no prazo, a cópia não começa: não se anuncia um snapshot completo.

### Retomada da conexão após a migração

Antes de pausar a sessão, o worker registra a intenção de retomada. Ela só é
elegível se `autoConnect=true`, o status anterior for `online` ou `connecting`
**e** houver um cliente local no worker dono. Um marcador `online` isolado no
Redis não autoriza reconectar. Sessões anteriormente offline e fixtures não
são retomadas. O guard global de efeitos externos também impede esse fluxo.

Depois do cutover, backup verificado, limpeza da origem e liberação da lease antiga, o coordenador
revalida dono, storage, geração e configuração. Quando permitido, restaura
`autoConnect=true` e publica o pedido de reconexão pelo fluxo normal. A tarefa
de migração informa, em `result`, por exemplo:

```json
{ "autoConnect": true, "reconnect": { "status": "requested" } }
```

`requested` confirma somente que o pedido foi publicado, **não que o WhatsApp
está online**. A conexão precisa ser confirmada pelo estado/evento do socket.
`skipped` indica que a retomada não foi solicitada e pode trazer um motivo;
`failed` indica falha ao restaurar a intenção ou publicar o pedido. Em falha de
coordenação, confira a configuração atual antes de repetir qualquer ação. Se a
publicação falhar, `autoConnect` pode continuar `true`, mas a conexão não está
confirmada. Isso não desfaz o banco SQLite já migrado e não autoriza repetir a
migração; consulte o motivo e trate a conexão separadamente.

O estado do descritor de armazenamento, inclusive `offline`, não representa o
estado atual do socket WhatsApp. Conclusão da cópia, pedido de reconexão e
conexão efetiva são confirmações distintas.

A conversão para as tabelas nativas usa os bytes e metadados do snapshot
local já capturado, não uma segunda leitura tardia no Redis. Registros que
expiraram normalmente entre as fases não devem interromper a migração nem
ganhar uma nova validade. Conteúdo ausente ou inválido sem expiração comprovada
continua sendo erro: nunca criar uma mensagem substituta ou alterar seus IDs.

Após o servidor aceitar uma tarefa válida, o modal fecha e o progresso aparece
na visão geral, em etapas legíveis. Falhas no pedido, tarefas já encerradas com
erro ou respostas inválidas mantêm a confirmação aberta e mostram o erro.
Essa mudança visual não altera a tarefa
nem transforma aceite HTTP em conclusão da migração.

A consulta automática da tarefa é limitada. Se falhar ou atingir o limite,
utilize **Atualizar tarefa**; não reenviar o POST por timeout. A tarefa
é consultada no plano de controle Redis, sem depender da geração recém-alterada
ou da disponibilidade do worker dono. Isso não confirma a integridade do banco.
Uma tarefa interrompida exige conferência do catálogo e do journal antes de nova tentativa.
Não excluir o volume ou ligar a mesma sessão em outra instância durante o fluxo.
No laboratório, tarefas longas exigem worker com comando Node estável: o
hot reload de `dist` pelo nodemon pode interromper a cópia sem reiniciar o
container Docker. Compilar não recarrega esse worker estável; após concluir as
tarefas, a atualização do processo exige reinício manual coordenado.

Uma migração bem-sucedida não mantém uma segunda cópia da sessão no Redis:
`result.sourcePreserved=false`, `backupId` e `sourceCleanup` informam a finalização.
Configure um destino S3 privado antes de migrar; novos backups não exigem chave.
Se backup, verificação ou limpeza
falharem após o cutover, o SQLite continua preservado e offline; a tarefa falha
sem solicitar reconexão. Chaves divergentes são preservadas, nunca apagadas à força.
Não repetir a migração: consultar o journal e finalizar a origem com o endpoint
específico após conferência. Migrações antigas podem ter deixado a origem Redis;
não há limpeza retroativa silenciosa. Essa origem não é rollback válido depois
de novas gravações no SQLite.

### Finalização de uma origem antiga ou interrompida

`POST /{version}/{phone}/storage/source-cleanup` aceita
`{ "confirm": true, "backupId": "UUID_DO_BACKUP", "generation": 3 }`.
É uma operação destrutiva separada: exige login de administrador, sessão SQLite
offline com conexão automática desativada, geração atual, backup em estado
`ready` e snapshot de migração. Antes de excluir, baixa e restaura o pacote de
backup em diretório temporário e compara o SHA-256 da tabela de fingerprints
com o banco atual. Depois, por lote, um comando atômico Redis revalida catálogo,
geração, token de posse, manifesto, SHA-1 dos bytes de origem e expiração antes
de executar `UNLINK`. Chaves com conteúdo ou TTL alterados são preservadas e
contabilizadas como divergentes. Catálogo, coordenação, chaves globais e SQLite
não fazem parte da exclusão.

Consultar a tarefa até o fim; aceitação não confirma exclusão. Bytes das chaves
comparadas não são RSS imediatamente devolvido ao sistema. Não executar limpeza
por timeout ou desconexão. Esse endpoint recupera uma finalização antiga ou
interrompida; novas migrações executam os mesmos controles automaticamente,
após backup verificado e antes da reconexão.

## Desconectar não é apagar histórico

Suspender conexão, remover o vínculo e apagar definitivamente são operações
distintas. Desconectar não deve excluir o arquivo SQLite ou as referências
históricas UnoID ↔ provider ID. Limpar credenciais de um vínculo não autoriza
apagar as tabelas históricas do ViperConnect.

A retenção de mensagem continua valendo: preservar no logout não significa
retenção infinita. A migração conserva `expires_at` original; ela não inicia
novos 30 dias para cada registro antigo. Exclusão definitiva precisa de uma
ação explícita com autorização e política de backup.

### Manutenção e tarefas interrompidas

O worker dono executa manutenção na inicialização e a cada 60 segundos, sem
sobrepor ciclos. Cada sessão SQLite elegível recebe orçamento de até 500 linhas
expiradas por passagem. Sessões de outro dono, fixtures, tarefas com lock e
trabalhos/eventos em andamento são ignorados. Auth, Signal e demais chaves
criptográficas não entram na poda; tombstones e a política de retenção são
preservados. Não há `VACUUM` automático: páginas liberadas podem ser reutilizadas
pelo SQLite, mas isso não promete arquivo menor nem RAM devolvida ao sistema.

O mesmo coordenador inspeciona transições interrompidas e journals pendentes,
sem conectar, reenviar, promover arquivos ou excluir a origem. Só pode reparar
metadados quando identidade, geração, arquivos e lease permitem uma conclusão
segura. Origem Redis sem comprovação de integridade, arquivo promovido ou fase
ambígua permanece em `recovery_required`, com ação de conferência explícita.
Falha de limpeza após cutover continua exigindo a finalização verificada da
origem. GETs do painel apenas leem os recibos; consultar o estado não inicia
manutenção ou recuperação.

## Backup e recuperação

### Pelo painel, sem terminal

Somente administradores com login podem gerar, baixar ou restaurar os pacotes.
Em **Gerenciar → Visão geral → Armazenamento da sessão → Backup e opções**,
solicite **Gerar backup**. A área **Backup e restauração** permite baixar o
último arquivo e os backups disponíveis de cada dia da semana. O download é
autenticado pelo painel; não expõe uma URL pública ou o token na URL.

Para levar o arquivo a **outro servidor**, no painel do destino abra
**Backups de sessões → Restaurar sessão** e selecione o `.viperstorage`:

1. Informe o telefone do backup e escolha um worker SQLite disponível.
2. Confirme que a origem está pausada e não será conectada simultaneamente.
3. Clique em restaurar e acompanhe a tarefa; o limite de upload é **256 MiB**.
4. Após sucesso, **Gerenciar sessão restaurada** abre o cadastro, sem conectar.
   Confira as credenciais e integrações antes de habilitar a conexão.

**O arquivo recria o SQLite em um servidor sem essa sessão? Sim.** Um pacote
válido recria o arquivo SQLite no volume persistente do worker e o cadastro
necessário no Redis do destino, recuperando credenciais, mensagens, contatos
e referências de IDs presentes no backup. Não é preciso copiar um `.sqlite`
separado, cadastrar o número manualmente ou ler outro QR antes da importação.
Ao terminar, a sessão fica offline e com webhooks desativados para conferência.

**Servidor sem cadastro não significa dispositivo desvinculado no WhatsApp.**
Se o dispositivo foi removido em **Aparelhos conectados** no celular, as
credenciais podem ter sido revogadas. Restaurar o backup não desfaz essa
revogação: nesse caso será necessário novo pareamento. Reutilizar o vínculo
sem QR depende de as credenciais restauradas continuarem válidas no WhatsApp.

O destino precisa estar vazio para esse número e suas identidades correlatas.
Não cadastre nem leia outro QR antes de importar. A restauração preserva IDs e
histórico, define um novo UUID/dono e mantém `autoConnect=false`, offline e
webhooks desativados. O token de API da sessão do snapshot é preservado nessa
recuperação completa: revise ou rotacione a credencial de forma autorizada.
As mídias continuam no S3 e precisam estar acessíveis no destino; elas não são
copiadas pelo pacote. A confirmação não verifica remotamente se a origem parou.
Redis compartilhado ainda contendo a sessão gera conflito, não troca automática
de proprietário. Não apague o catálogo para forçar a importação.

Esse formulário cria uma **sessão ausente**. Já o botão **Restaurar arquivo de
backup** dentro de uma sessão SQLite existente exige pausa/offline e reconexão
automática desativada; ele não é uma opção para sobrescrever um cadastro ativo.
Os formatos Redis `.vipersession` e `.viperdevice` mantêm seu fluxo próprio.
Para SQLite, o bloco legado duplicado de transferência fica oculto.

Um aceite HTTP 202 ainda não é sucesso: aguarde o estado `ready`. Falha ou
resposta ambígua não dispara reenvio automático. Consulte a tarefa existente
antes de repetir; se houver material já promovido, preserve os identificadores
de recuperação. Nenhum restore inicia conexão, chamadas ou replay de mensagens.

O destino precisa executar esta versão do código, com Redis, S3 e volume
SQLite válidos. A lista usa o nome local `UNOAPI_SERVER_NAME`, donos de sessões
persistidas e, opcionalmente, `SESSION_STORAGE_RESTORE_WORKERS=worker_1,worker_2`.
São nomes autorizados, não endereços de rede ou caminhos. A capacidade é
confirmada por RPC no worker real. Workers sem volume ou indisponíveis não
podem ser escolhidos. Uploads órfãos têm limpeza eventual após 24h, limitada
por rodada e protegida contra remoção durante uma operação em andamento.

Contratos administrativos: `GET /manager/storage/workers`,
`POST /manager/storage/restore-upload`,
`GET /manager/storage/restores/{phone}/{id}`,
`GET /manager/storage/{phone}/backups` e
`GET /manager/storage/{phone}/backups/{id}/download` (`id` aceita `latest`).
O POST usa telefone, worker e confirmação na query, corpo binário
`application/octet-stream` e `Content-Length` exato; não aceita caminhos locais,
URL S3 arbitrária, senha ou chave pelo navegador.

O painel permite solicitar backup manual por tarefa. O agendamento usa
`SESSION_STORAGE_BACKUP_ENABLED=true` e
`SESSION_STORAGE_BACKUP_INTERVAL_HOURS=12`. Configure o destino S3 compatível
da stack. **Novos backups são gravados sem criptografia e não exigem chave ou
senha**, inclusive quando já existe uma chave antiga configurada no worker.
O pacote `.viperstorage` contém credenciais, configuração e histórico: mantenha
o bucket e os arquivos privados, limite as permissões e use transporte seguro.
Verificação de integridade não fornece confidencialidade nem torna confiável
um arquivo obtido de uma origem desconhecida. Destino ausente ou falha de
verificação deve retornar erro explícito, nunca anunciar sucesso.

O Compose do laboratório habilita a agenda das sessões SQLite por padrão.
A execução inicial e as seguintes usam
duas janelas UTC de 12 horas. Reservas são renovadas durante o upload; uma falha
permite nova tentativa na mesma janela, sem registrar sucesso nem sobrepor dois
backups da mesma sessão. Fixtures não entram na agenda. `backupPolicy` no GET de
armazenamento e nos detalhes técnicos mostra agenda e último sucesso/erro sem
segredos. Produção precisa habilitar a rotina separadamente: o DEV não altera a VPS.

### Compatibilidade com backups antigos

Backups criptografados existentes continuam legíveis com a **mesma chave**
usada na criação. `SESSION_STORAGE_BACKUP_KEY_FILE` é opcional para os formatos
novos e serve à leitura dos arquivos antigos. Se o arquivo e sua configuração
já existem no worker, **preserve ambos**; não apague, regenere ou substitua a
chave para adotar o formato novo. Guarde uma cópia segura desse material fora
do worker para recuperação dos backups legados.

Sem a chave correspondente, o restore de um arquivo antigo falha explicitamente;
isso não impede criar ou restaurar os novos pacotes sem chave. Não envie chave
ou senha no navegador, no payload HTTP, nos argumentos de comando ou nos logs.
As chaves próprias do Mobile Primary e outros serviços continuam distintas:
retirar a criptografia do backup não elimina os requisitos desses serviços.

### Rotação semanal e localização no S3

No laboratório, `SESSION_STORAGE_BACKUP_ROTATION=weekly` seleciona **sete slots,
um por dia da semana**. `SESSION_STORAGE_BACKUP_TIMEZONE=America/Cuiaba` define
o dia correspondente; utilize um fuso IANA válido. As janelas da agenda continuam
sendo de 12 horas: o fuso dos slots não muda esse intervalo. Sem `weekly`, a
política é `retain-all`, não uma exclusão automática por idade.

Cada novo backup verificado pode substituir o ponteiro do mesmo dia, inclusive
na segunda execução diária. São sete pontos canônicos, **não** quatorze arquivos
garantidos nem retenção mínima de sete dias.
Primeiro valida e publica o novo objeto; só depois aposenta os objetos sem
referência, com margem de segurança e locks. Falhas preservam o slot anterior;
uploads, objetos em verificação e falhas de limpeza podem manter mais arquivos
temporariamente. A política também pode ser aplicada ao backup global Redis,
em namespace separado. Não configure um lifecycle S3 incompatível que remova
arquivos ainda apontados pelos slots.

Backups criptografados legados são uma exceção preservada: seus arquivos,
manifestos e índices não são apagados pela rotação ao adotar o novo formato.
Por isso, eles podem existir além dos sete slots novos sem criptografia.

O painel mostra o bucket e o prefixo efetivos, sem credenciais ou caminhos do
worker. Os backups de uma sessão usam:

```text
backups/session-storage/{phone}/{UUID}.viperstorage
backups/session-storage/{phone}/{UUID}.viperstorage.manifest.json
backups/session-storage/{phone}/slots/0.json ... slots/6.json
```

Os slots vão de domingo (`0`) a sábado (`6`) e contêm ponteiros para manifestos
verificados. O arquivo e seu manifesto S3 não dependem do índice Redis antigo
para serem encontrados. Proteja o bucket e os materiais de recuperação externos,
incluindo a chave de arquivos legados; um manifesto não é uma autorização
pública de download.

O pacote inclui banco, cópia da configuração da sessão e, no
Mobile Primary, suplemento de registro/dispositivos. Só é publicado como `ready`
após leitura de volta e restauração verificada do objeto S3. A configuração é
material de recuperação: o restore offline não reaplica tokens, webhooks, donos
ou conexão automática. Arquivos de mídia continuam no S3; chaves próprias do
Mobile Primary ou de outros serviços exigem guarda segura independente quando
necessárias, sem serem uma chave obrigatória para o novo pacote de backup.

O snapshot deve ser consistente com o WAL e acompanhado de manifesto de
integridade e versão. Um `.sqlite` isolado não substitui o pacote `.viperstorage`;
copiar só `session.sqlite` ativo também não é um backup consistente.
O backup do Redis deve preservar catálogo/configuração e permitir
reconciliação; não deve reativar automaticamente leases e donos antigos.

### Restore SQLite offline

O endpoint de restore já prepara e publica um **novo UUID de armazenamento**
para uma sessão SQLite existente e offline, preservando o arquivo anterior.
Exige `autoConnect=false`, posse exclusiva, backup da mesma sessão, integridade
e consistência das duas direções UnoID ↔ provider ID. O destino continua offline;
não há reconexão nem replay. O runtime recusa destino Redis, sem mesclar ou
substituir dados existentes.

O painel também pode enviar um arquivo `.viperstorage` pela rota
`POST /{version}/{phone}/storage/restore-upload?confirm=true&mode=offline`.
Ela exige o mesmo administrador, destino SQLite existente offline,
`autoConnect=false` e ausência de cliente ativo. Novos pacotes não precisam de
chave; somente arquivos antigos criptografados exigem a chave correspondente
configurada no worker. Envie o arquivo como corpo binário `application/octet-stream`, com
`Content-Length` exato, de 1 byte até **256 MiB**. Não é multipart, JSON,
Base64 ou upload direto de um `.sqlite`; não enviar senha/chave na requisição.

O upload é transmitido para staging S3 privado; o worker confere novamente o
destino antes de validar e restaurar em novo UUID; arquivos antigos também são
descriptografados com a chave existente. O aceite 202 ainda exige acompanhar a
tarefa. Erro de chave legada, identidade, integridade ou
limite não vira sucesso nem fallback para um banco vazio. A disponibilidade
informada pelo painel não ativa a conexão e não substitui essas verificações.

Em Mobile Primary, o suplemento de registro e dispositivos do backup precisa
ser igual ao estado atual no Redis. Divergência retorna
`session_storage_primary_state_changed`; o restore não sobrescreve esse estado
compartilhado. O snapshot SQLite e o suplemento Redis não formam uma transação
distribuída: a rotina captura os controles antes do snapshot e os relê depois,
abortando antes do upload se houver mudança, com até três tentativas limitadas.
Isso não é confirmação de credenciais ainda aceitas pelo WhatsApp. Não tratar
um SQLite solto ou um teste sintético como recuperação validada do aparelho.

### Recuperação sem o catálogo anterior

A recuperação operacional standalone obtém do S3 o pacote de backup e seu
manifesto, por ID de backup ou slot semanal, sem depender do catálogo Redis
anterior. Ela ainda exige **Redis de destino acessível e sem essa sessão**,
volume persistente do worker, identidade do novo dono e acesso S3. O formato
novo não exige `SESSION_STORAGE_BACKUP_KEY_FILE`; para arquivos antigos
criptografados, preserve e configure a chave correspondente. A origem deve estar desligada; o arquivo não
autoriza manter dois workers conectados com as mesmas credenciais.

O destino usa um novo UUID, `autoConnect=false` e webhooks desabilitados. Não
publica conexão nem replay. Para Mobile Primary, são necessários também o
cadastro descritivo do dispositivo, registro e estado de companions presentes
no suplemento, além de `MOBILE_REGISTRATION_KEY` válida no destino. Não recria
identidades criptográficas para contornar material ausente ou divergente.

Com a origem parada, execute dentro do worker de destino com suas ENVs já
configuradas. Os comandos abaixo não exigem chave para o formato novo; para
um backup antigo criptografado, configure o arquivo da chave no worker, nunca
na linha de comando:

```bash
node scripts/restore-session-from-s3.cjs --phone 5511999999999 --backup-id 12345678-1234-4234-8234-123456789abc --confirm-offline
# Alternativa: último backup do slot de domingo, sem o índice Redis anterior
node scripts/restore-session-from-s3.cjs --phone 5511999999999 --weekday 0 --confirm-offline
```

Não execute os dois comandos para a mesma recuperação: escolha um. Um destino
existente é recusado, não sobrescrito. O primário precisa de auth nativo já
importado (`mobilePrimaryImported=true`) no snapshot; cadastro ainda não
importado é recusado explicitamente. Se houver falha após promover o arquivo,
os identificadores de recuperação permitem inspecioná-lo sem adivinhar um
rollback ou repetir a operação às cegas.

Backups antigos sem configuração recuperável ou, no primário, sem os dados do
dispositivo, **não garantem recuperação completa**. Essa ferramenta não restaura
filas RabbitMQ, mídia ausente do S3, o RDB nem o restante da stack. Credenciais
podem ter sido revogadas pelo WhatsApp: integridade do arquivo e testes
sintéticos não comprovam conexão ou recuperação real em produção.

### Backup global Redis para S3

**Para que serve:** é uma cópia do Redis inteiro, não de um número isolado.
Mesmo com sessões em SQLite, Redis guarda configurações, usuários/permissões,
webhooks, catálogo, coordenação e referências compartilhadas; dados de sessões
que ainda usam Redis também entram na cópia. Ele não inclui os arquivos SQLite,
as mídias S3 nem as filas RabbitMQ. Para recuperar somente uma sessão SQLite,
use seu `.viperstorage`; não restaure o Redis inteiro para isso.

**Como restaurar:** hoje não há botão de restauração global do Redis no painel.
O arquivo `.rdb.viperbackup` é um pacote da aplicação, não um `dump.rdb` pronto
para copiar diretamente para o volume. O procedimento de infraestrutura é:

1. Parar os serviços que usam esse Redis e preservar uma cópia recuperável do
   volume atual. A restauração global pode voltar dados de todas as sessões.
2. Selecionar o pacote e seu manifesto no S3. A rotina `prepareRestore` extrai
   e verifica um novo RDB em staging, sem substituir o serviço em execução.
3. Validar esse RDB com uma versão compatível de Redis/Valkey e sua ferramenta
   `redis-check-rdb` ou equivalente. Planejar a ativação com o Redis parado.
4. Tratar a configuração de persistência: **se AOF estiver habilitado, ele tem
   precedência sobre o RDB**. Não basta colocar `dump.rdb` ao lado dos arquivos
   AOF antigos, nem apagar o volume para forçar o carregamento. Preserve rollback
   e siga o procedimento correspondente à versão de Redis/Valkey implantada.
5. Antes de liberar os workers, conferir catálogo, donos, leases e tarefas
   restauradas; depois reativar os serviços e validar as sessões sem replay.

Essa rotina prepara o arquivo, mas não executa automaticamente os passos de
ativação. A recuperação completa da stack precisa também dos volumes SQLite
e do S3. Um snapshot global não é uma migração entre servidores nem autoriza
origem e destino simultaneamente ativos.

A rotina global está implementada no coordenador, mas vem **desativada**. Além
do S3 configurado na stack, sua ativação exige opt-in explícito para todas as
bases Redis e o executável compatível:

```yaml
environment:
  SESSION_STORAGE_REDIS_BACKUP_ENABLED: "true"
  SESSION_STORAGE_REDIS_BACKUP_ALL_DATABASES: "true"
  SESSION_STORAGE_REDIS_CLI_PATH: /usr/bin/redis-cli
  SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID: redis-principal
```

Novos backups globais também não exigem chave de backup; preserve a chave
existente para recuperar os arquivos legados criptografados. A URL Redis e o
destino usam `REDIS_URL`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET_NAME` e
as credenciais S3 já configuradas; não colocar senhas nos comandos. TLS com CA
própria pode usar `SESSION_STORAGE_REDIS_BACKUP_TLS_CA_FILE`.

A rotina usa `redis-cli --rdb`: captura **todas as bases**, mesmo quando a URL
seleciona uma delas, e exige autorização/ACL para esse escopo. Pode provocar fork
e pico de RAM por copy-on-write no Redis; revisar capacidade antes de habilitar.
O CLI é incluído pelos Dockerfiles atualizados (`redis-tools`), mas isso requer
rebuild da imagem; a imagem DEV já iniciada não ganha o pacote automaticamente.

Há uma reserva compartilhada por janela de 12 horas, para evitar backups
duplicados entre réplicas, e verificação do arquivo enviado por leitura de volta.
O backup e seu manifesto usam prefixo S3 próprio: mantenha objetos
privados e configure retenção/lifecycle sem afetar a mídia das sessões. Não há
mistura com o banco de uma sessão: os objetos globais ficam em
`backups/redis/{instanceId}/`, com arquivos `.rdb.viperbackup`, manifestos
`.manifest.json` e, em rotação semanal, `slots/0.json` a `slots/6.json`. Não há
uma nova rota HTTP de restore global. A preparação de recuperação gera somente
um RDB offline novo: não executa `RESTORE`, troca `dump.rdb`/AOF, reinicia Redis
ou ativa sessões. Antes de uma ativação operacional, validar o RDB e reconciliar
leases, donos e tarefas antigas.

Um intervalo de 12 horas tem **RPO nominal de até 12 horas**, se todas as
execuções tiverem sucesso; backups falhos ampliam a janela. Restore, migração
entre servidores e recuperação de Mobile Primary precisam de validação no
destino e exclusividade da origem. Backup não garante que credenciais antigas
continuem válidas no WhatsApp. A validação sintética não substitui testes
autorizados com sessões reais; não reexecutar mensagens durante o restore.

As rotas antigas de transferência Redis e os backups de dispositivos não devem
ser apresentados como compatíveis com SQLite até os respectivos adapters e
testes estarem integrados. A publicação desta página não prova que todas as
rotinas já foram validadas em produção.

## Indicadores no desenvolvimento

A visão geral mostra apenas indicadores aplicáveis ao backend: memória Redis
estimada **ou** tamanho SQLite em disco e quantidade de registros, junto da RAM
compartilhada do worker. Não atribui RAM exclusiva à sessão nem preenche campos
SQLite indisponíveis em sessões Redis. UUIDs, geração, códigos de diagnóstico,
WAL/SHM, memória do container e demais informações ficam em **Detalhes técnicos**,
recolhidos inicialmente; abrir ou fechar os detalhes é preservado durante as
atualizações automáticas. O modal contém somente o resumo da operação, aviso,
confirmação explícita e ação correspondente, sem duplicar a visão geral.
A confirmação marcada é preservada ao abrir os detalhes; respostas de consultas
em segundo plano não recriam o formulário. Fechar e reabrir a operação exige nova
confirmação. Essa reorganização visual não altera endpoints, permissões ou dados.

O painel consulta métricas a cada cinco segundos enquanto a página está ativa:
RSS, heap e memória externa pertencem ao **worker inteiro**, não a uma sessão.
RSS e tamanhos dos arquivos são atualizados em cada consulta. Contagens,
estimativas de dados e metadados SQL podem ser reutilizados por até 60 segundos;
consulte os horários e o indicador de amostra parcial antes de comparar valores.
O tamanho SQLite/WAL/SHM é **disco**, não RAM. A estimativa de memória Redis
informa a quantidade de chaves amostradas. Tempo da migração e tamanhos antes e
depois não podem ser interpretados como RAM liberada se a origem for preservada.
O orçamento de cache da conexão é **soft**, de 1 MiB por banco aberto. Uno e
SDK compartilham a conexão `node:sqlite`; não há cache SDK adicional de 2 MiB.
Esse orçamento não é teto de RAM por sessão nem medição de consumo residente.
Métricas informam a versão SQLite real. O worker exige SQLite 3.51.3 ou superior
antes de ativar WAL, incluindo a correção do [WAL-reset](https://sqlite.org/wal.html).
Engine ausente ou antiga também bloqueia a capacidade e mantém novas sessões
em Redis, com aviso; backup e restore usam a API SQLite nativa validada.

Em Linux com cgroup v2, o painel também mostra total do container, memória
anônima, arquivos/cache, arquivos inativos e kernel. São indicadores
compartilhados, não custos individuais: não somar novamente ao RSS. Cache
inativo não é RAM livre garantida. A quantidade de clientes carregados não
conta bancos SQLite offline. A média real exige comparação antes/depois sob
carga equivalente e estável; um piloto offline não dimensiona 100 conexões
WhatsApp ativas.

## Contrato HTTP

As operações exigem login Manager de administrador, não somente o número de
telefone, token de sessão ou chave pessoal de API. Não retornam caminhos locais,
chaves, credenciais ou conteúdo de mensagens.

O GET de armazenamento informa `autoConnect`, o estado conhecido
`connectionStatus` e `restoreUpload.available`, além do descritor do banco.
Esses campos ajudam o painel a exigir suspensão antes do upload; não são
confirmação de entrega no WhatsApp nem autorização para ignorar a validação
feita pelo worker no momento da operação.

`backupPolicy.protection="none"` identifica a política dos novos backups sem
criptografia. `lastBackup.protection`, quando informado, descreve o arquivo
registrado; sua ausência em um recibo antigo não substitui a validação do
formato no restore. Esses campos não expõem nem solicitam uma chave.

| Método | Caminho | Finalidade |
| --- | --- | --- |
| GET | `/{version}/{phone}/storage` | Backend, dono, geração, tarefa e capacidade do worker |
| POST | `/{version}/{phone}/storage/migrations` | `{ "target": "sqlite", "confirm": true }` |
| GET | `/{version}/{phone}/storage/tasks/{taskId}` | Resultado da tarefa; consultar antes de repetir operações |
| POST | `/{version}/{phone}/storage/backups` | `{ "confirm": true }`, pacote verificado sem criptografia |
| GET | `/{version}/{phone}/storage/metrics` | Memória do processo e indicadores de disco da sessão |
| POST | `/{version}/{phone}/storage/restores` | `{ "backupId": "ID_DO_BACKUP", "mode": "offline", "confirm": true }`, restaurar sem conectar ou reenviar |
| POST | `/{version}/{phone}/storage/restore-upload?confirm=true&mode=offline` | Pacote `.viperstorage` binário, até 256 MiB; restore offline por tarefa |
| POST | `/{version}/{phone}/storage/source-cleanup` | Remover origem Redis somente após backup e comparação, com confirmação e geração |

Resultados `ready` no worker ou `succeeded` quando normalizados pelo gateway
são terminais de sucesso. `failed` e `interrupted` não autorizam retry automático.
Os fluxos implementados continuam em validação DEV; esta página não declara
restore de grande volume ou recuperação real de primário validada em produção.

Referência completa e respostas: [API](/api-reference).

## Identidade do worker em múltiplos servidores

Cada worker com volume SQLite próprio precisa de um `UNOAPI_SERVER_NAME`
explícito e único, por exemplo `worker_1` e `worker_2`. O nome identifica o
destino das filas e precisa permanecer estável ao reiniciar o mesmo worker com
seu volume. `UNOAPI_STORAGE_WORKER_ID` deve estar ausente/vazio ou ser exatamente
igual a esse nome; um alias divergente não é suportado.

```yaml
services:
  worker-zapo-1:
    environment:
      UNOAPI_SERVER_NAME: worker_1
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
    volumes:
      - worker_1_sessions:/app/session-data
  worker-zapo-2:
    environment:
      UNOAPI_SERVER_NAME: worker_2
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
    volumes:
      - worker_2_sessions:/app/session-data
volumes:
  worker_1_sessions: {}
  worker_2_sessions: {}
```

O exemplo é somente o fragmento de identidade/volume: preserve os demais
serviços, variáveis, imagem e redes da stack. Não crie réplicas com o mesmo nome
ou compartilhe o mesmo arquivo SQLite entre workers. A seleção do servidor da
sessão precisa corresponder ao worker de destino; esta configuração não faz
balanceamento, cópia de volume ou failover automático.

Quando há alias divergente, a capacidade SQLite fica indisponível e
provisionamento, migração e restore são recusados antes de preparar arquivos.
O consumer específico de storage não registra uma fila com identidade ambígua,
mas esse bloqueio não derruba indiscriminadamente o worker Redis legado. O guard
valida a configuração local; detectar dois containers com o mesmo nome e volume
continua sendo responsabilidade da implantação.

## Snapshots privados e caches da sessão

Depois da migração, os snapshots do próprio perfil e de privacidade, os
metadados da capa e os caches de foto (inclusive ausência e intervalo de
webhook) acompanham o backend da sessão. As famílias `status-recipients`,
`status-media` e `status-media-recovery` também são copiadas com seus prazos de
expiração; não se confundem com o estado de conexão `unoapi-status`, que
continua no Redis.

O lock temporário da capa permanece no Redis para coordenar concorrência;
o registro permanente da capa fica no SQLite e o arquivo da imagem permanece
no armazenamento S3. Atualizações de snapshots usam comparação de geração, e
a capa usa comparação do registro anterior para não apagar uma substituição
mais recente. Chamadas de outro processo são encaminhadas ao worker dono;
nenhuma ausência do SQLite autoriza reconstruir esses dados a partir de um
cache Redis antigo. As operações de cache ainda no Redis verificam backend e
geração no mesmo comando Lua da leitura ou gravação; uma requisição iniciada
antes da migração não pode recriar a origem depois dela. Mudança de geração,
migração em curso e SQLite ausente retornam erro explícito. Falhas genéricas de
cache mantêm a tolerância anterior; uma alteração remota da capa já confirmada
retorna sucesso com aviso de metadados, sem provocar reenvio.

A importação e a limpeza usam a mesma lista explícita de famílias de dados.
Chaves desconhecidas não são importadas nem apagadas automaticamente. Backups
legados que também copiaram `history-sync:{phone}:started` ou
`webhook-history:{phone}` mantêm esses controles no Redis: a limpeza os informa
em `retainedControl`, sem tratá-los como dados divergentes ou impedir a
conclusão. Outros registros fora da lista continuam em `skippedScope` e exigem
análise; não ganham uma exceção genérica de remoção.
