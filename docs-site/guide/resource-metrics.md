# Consumo de RAM, CPU e disco

No painel inicial do Manager, clique em **Gerenciador de recursos**, com ícone de
monitor ao lado de **Atualizar agora**. A tela dedicada mostra cada processo
ViperConnect (`web`, `worker`, `broker`, `video` ou `all`), Redis, RabbitMQ e o VoIP configurado.
Os indicadores não ocupam a lista inicial de sessões. O card inteiro é clicável:
abre os detalhes com RAM/CPU/disco, períodos **1 dia, 7 dias, 30 dias, 90 dias e Máx.**
e, nos serviços atuais, ações **Logs** e **Reiniciar serviço**. Os botões operacionais
ficam dentro dos detalhes, não espalhados na grade. Fechar Logs ou a confirmação
volta aos detalhes do mesmo serviço, preservando o período/histórico selecionado.
O botão **Dashboard** retorna à tela inicial.

### Containers recriados

Após três minutos sem coleta, uma instância expira. Se existe outra instância
recente com o mesmo servidor/papel, a antiga sai dos cards principais e fica em
**Instâncias anteriores**, seção recolhida com acesso aos gráficos já arquivados.
Não são apagadas chaves ou objetos S3 para corrigir a lista. Réplicas com coletas
recentes e servidores diferentes permanecem separados. Sem instância recente,
fica somente a última medição conhecida por servidor/papel, nunca marcada ao vivo.
O prazo permite distinguir atraso de coleta de encerramento, sem acessar Docker.

A identificação automática usa o formato padrão `servidor · papel · hostname`.
Nomes personalizados não são agrupados por semelhança; use
`RESOURCE_METRICS_INSTANCE_ID` único e estável para preservar a mesma série.
Os totais atuais não incluem instâncias antigas. O endpoint `/admin/resources`
separa `components` e `historicalComponents`; o histórico por ID continua disponível.
Disponível somente para administrador; credenciais de uma sessão ou usuário
comum não autorizam a infraestrutura global.

## Como interpretar

- Em container Linux/cgroup v2, a RAM do card é o consumo do cgroup menos
  `inactive_file`, aproximando a leitura operacional do Docker. Inclui processos
  filhos e outros processos no mesmo container. Não é RAM exclusiva das sessões.
- O detalhe separa RSS do processo, heap JavaScript, cache de arquivos e total do
  container com cache. Sem cgroup disponível, usa RSS e identifica essa origem.
- Redis usa RSS global do servidor Redis. O detalhe separa memória alocada,
  dataset, overhead, pico e fragmentação. A quantidade de chaves corresponde
  apenas ao banco selecionado pela stack, não necessariamente a todos os bancos.
- CPU usa a diferença do tempo acumulado de processamento dividida pelo tempo
  decorrido entre coletas: **100% = um núcleo**; 250% = 2,5 núcleos em média.
  Não é percentual da capacidade total do host nem é normalizado pela quota.
  Em cgroup v2, inclui todos os processos do container (também filhos, como FFmpeg);
  sem esse suporte, usa somente o processo Node e informa `cpuSource=process`.
  Redis usa `INFO cpu` do servidor inteiro, não só do banco selecionado. VoIP
  segue a mesma regra de container/processo. A primeira coleta após início ou
  troca de fonte apenas estabelece referência; mostra **—**, não zero inventado.
- O total de CPU também deduplica containers e indica leitura parcial se faltar
  CPU de algum serviço. É soma de serviços monitorados, não CPU total do host.
  Os gráficos preservam a média e o maior percentual **observado entre coletas**;
  picos menores que um minuto podem não aparecer. Medições antigas sem CPU
  permanecem sem esse dado; não há preenchimento retroativo.
- O total soma os serviços **observados**, deduplicando o mesmo container Linux.
  Não é a RAM total do host e não inclui Coturn, servidor S3, docs,
  compiladores ou outros aplicativos. Serviços ausentes tornam o total parcial.
- Disco mede tamanhos de arquivos locais dos diretórios de dados, incluindo
  SQLite/WAL e mídia local. Não mede tamanho remoto do bucket S3, velocidade de
  gravação ou RAM. Volumes compartilhados não devem ser somados entre workers.
- A capacidade usada/total do filesystem é compartilhada com outros dados.
  Redis informa somente o AOF disponível por `INFO persistence`; essa leitura
  é **parcial** e não inclui RDB, arquivos antigos ou todo o volume Redis.

### RabbitMQ

Incluído no total de RAM usando `mem_used` dos nós em execução, com a estratégia
informada pelo servidor (`rss`, `allocated` ou mista/desconhecida). Não representa
necessariamente o consumo inteiro do container. Um nó ausente ou sem medição
torna a RAM parcial. O detalhe apresenta nós ativos, alarmes/limites de memória e
disco, filas, conexões, canais, consumidores, mensagens prontas/sem ACK e taxas
de publicação/entrega. Contadores são **globais do cluster**, não só da sessão,
prefixo de filas ou vhost desta stack. Não se deve somá-los em painéis por sessão.

O gráfico de **Disco livre** usa o menor espaço livre observado entre os nós,
guardando o mínimo nos intervalos agregados. Não mede tamanho dos dados ou filas
do RabbitMQ e não entra na soma de arquivos dos workers. A CPU vem opcionalmente
do plugin `rabbitmq_prometheus`, já disponível no DEV: calcula a razão entre os
deltas dos contadores de runtime e wall-clock da VM Erlang, ambos na mesma unidade,
com **100% = um núcleo**. Reconhece pares `*_seconds_total` e o formato antigo
`*_milliseconds`, sem inferir CPU a partir do número de núcleos ou fila do scheduler.
Confere a identidade do nó contra a API Management. Reinício, mudança de nó,
contador inválido ou falha de acesso exigem duas novas leituras válidas; mostram
**—** nesse período, nunca zero inventado. Alarmes e nó parado são destacados.

Por padrão tenta `/metrics` na porta interna 15692 do mesmo host da Management,
sem publicar portas. `RABBITMQ_PROMETHEUS_URL` permite configurar a URL completa
interna (inclusive HTTPS) quando diferente. Reutiliza o Basic Auth do RabbitMQ se
o plugin exigir autenticação; não segue redirects. O scrape agregado tem timeout
de dois segundos e limite de 1 MiB, sem coletar métricas por objeto. Não precisa
instalar servidor Prometheus ou Grafana. Não habilita plugins automaticamente.
Se não houver plugin/contadores suportados, RAM/filas continuam sendo coletados,
mas CPU fica indisponível e o total de CPU é marcado parcial. Um endpoint de um
cluster com vários nós mede apenas a VM atendida, portanto CPU também é parcial;
não apresenta o consumo de um nó como se fosse de todo o cluster.

A coleta faz dois GETs Management e um scrape Prometheus agregados por minuto
(`/api/nodes`, `/api/overview` e `/metrics`, com
seleção de colunas); nunca abre mensagens, enumera cada fila ou altera o broker.
Reutiliza `AMQP_URL` para credenciais e deriva a porta Management 15672/15671;
`RABBITMQ_MANAGEMENT_URL` permite URL interna diferente. O usuário precisa de
permissão de monitoramento dos nós e do overview. Não adicionamos permissões
automaticamente nem expomos a API Management publicamente. Falhas de acesso
mantêm a última medição S3, ou **Sem medição**; nunca simulam consumo zero.

RAM, CPU e disco livre seguem o mesmo limite de 120 pontos e arquivamento S3 das
demais métricas; os contadores operacionais extras aparecem na última amostra.
Referências: [monitoramento oficial](https://www.rabbitmq.com/docs/monitoring) e
[plugin Prometheus](https://www.rabbitmq.com/docs/prometheus).

## Coleta leve e histórico no S3

A coleta de memória ocorre a cada minuto e independe de alguém abrir o painel.
O navegador consulta o resumo a cada 15 segundos somente no Gerenciador de recursos
visível, pausando enquanto o detalhe estiver aberto. A coleta do servidor continua
mesmo fora dessa tela. Não há consultas de métricas ao permanecer no Dashboard.
A leitura de disco é cacheada por dez minutos, sem abrir conteúdo dos arquivos,
sem seguir links simbólicos e com orçamento de 750 ms/10.000 entradas. Diretórios
maiores ou inacessíveis são explicitamente marcados como leitura parcial.

Redis guarda um resumo por serviço e um buffer com **no máximo 120 amostras**
(cerca de duas horas). O arquivamento começa na primeira coleta e depois ocorre
a cada 15 minutos. Após confirmação no S3, o buffer conserva aproximadamente os
últimos cinco minutos. Em falha de S3, não cresce indefinidamente: descarta pontos
antigos além do limite e informa a degradação. Uma interrupção longa pode causar
lacunas; não há promessa de recuperar amostras que nunca foram arquivadas.

O S3 já configurado na stack é reutilizado, com JSONs privados e somente números,
datas e nomes de processos. Não contém mensagens, telefones, credenciais ou
conteúdo de arquivos. Prefixo exibido no detalhe:

```text
metrics/v1/<stack>/<component>/hours/2026-11-15T10.json
metrics/v1/<stack>/<component>/days/2026-11-15.json
metrics/v1/<stack>/<component>/months/2026-11.json
metrics/v1/<stack>/index/<component>.json
```

`component` é um identificador hash de 24 caracteres hexadecimais. Objetos de hora
preservam minutos, os de dia preservam horas, os de mês preservam dias e o índice
preserva meses e a última medição. Médias ponderadas e picos são mantidos nas
agregações; CPU usa contagem própria (`cpuN`) para não incluir amostras antigas
sem CPU na média. Tamanho de disco é a última observação do intervalo.

| Filtro | Fonte histórica | Resolução nominal |
| --- | --- | --- |
| 1 dia | Objetos horários e buffer recente | Minuto |
| 7/30 dias | Objetos diários e buffer recente | Hora |
| 90 dias | Objetos mensais e buffer recente | Dia |
| Máx. | Índice mensal e buffer recente | Mês |

A resposta é limitada a 600 pontos, com agregação adicional quando necessário.
Consultas iguais em andamento são compartilhadas. O cache local tem no máximo
oito respostas por quinze segundos e há no máximo oito consultas históricas
simultâneas por processo web, com quatro leituras S3 concorrentes por consulta.
O histórico inicia na implantação desta funcionalidade; não cria 90 dias de
medições retroativas. Não há exclusão automática dos JSONs antigos: uma política
de ciclo de vida aplicada ao prefixo no bucket reduz a janela disponível.

### Falha ou perda do Redis

O Manager tenta consultar o catálogo e a última amostra no S3. Valores recuperados
mostram **Última medição**, data/hora e origem S3, nunca “ao vivo”. O histórico
arquivado também pode ser consultado sem o Redis. Falha de ambos aparece como
indisponibilidade; ausência não é preenchida com zero. Isso não torna a stack
independente de Redis: sessões, coordenação e fluxos operacionais ainda dependem
dele. A recuperação do histórico não recupera sessões nem substitui backups.
Em perda completa do Redis, o acesso HTTP exige o **token global da stack**.
Credenciais `mgr_` dependem da validação no Redis e continuam sendo negadas se
essa validação não puder ser feita; o fallback S3 não contorna autenticação.

## Configuração

```yaml
environment:
  # Opcional; mesmo valor em todos os processos da mesma stack.
  RESOURCE_METRICS_STACK_ID: viperconnect
  # Coleta habilitada por padrão no entrypoint cloud.
  RESOURCE_METRICS_ENABLED: "true"
  # Opcional, único/estável por processo fora de containers.
  # RESOURCE_METRICS_INSTANCE_ID: servidor-1-worker-1
  # Reutilizar STORAGE_BUCKET_NAME, STORAGE_ENDPOINT, STORAGE_REGION,
  # STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY e STORAGE_FORCE_PATH_STYLE.
```

Sem `RESOURCE_METRICS_STACK_ID`, usa `UNOAPI_QUEUE_NAME` ou `unoapi`. Não altere o
ID para consultar um histórico existente. Fora de containers, a identidade padrão
inclui o PID; configure um ID estável e único para manter a série entre reinícios.
Em Docker, recriar um container com outro hostname também inicia outra série.
O catálogo suporta até 128 componentes por stack. Não monte o socket Docker nem
conceda acesso privilegiado: os próprios processos publicam suas medições.
Para o único endpoint VoIP configurado, o resumo usa o container com medição mais
recente, sem somar uma instância anterior após recriação. O histórico anterior
continua no S3 e pode ser consultado pela API com o ID antigo.

O coletor de Redis/VoIP/total é eleito entre processos `web`/`all`, com lease
Redis de cinco minutos. Todos os workers precisam carregar o código novo; somente
atualizar o frontend não instrumenta processos antigos. Entrypoints legados
diretos não iniciam esta coleta; o entrypoint suportado é `cloud.js`.

O VoIP exige versão com `GET /v1/resources/metrics`, protegida por
`VOIP_SERVICE_TOKEN`. Um VoIP antigo não é tratado como consumo zero: aparece sem
medição, ou com a última amostra S3 se houver. Esse endpoint não muda SIP, áudio,
configuração, gravações ou dados de chamadas.

## API administrativa

- `GET /admin/resources`: resumo, total, origem/frescura, estado Redis/S3 e prefixo.
- `GET /admin/resources/{component}/history?range=1d|7d|30d|90d|max`: série agregada.
- No serviço VoIP direto: `GET /v1/resources/metrics`, com o token do serviço.

Use token global ou login Manager administrador nas duas rotas ViperConnect.
Respostas usam `Cache-Control: no-store`; IDs/períodos inválidos retornam 400 e
credenciais sem papel administrativo retornam 403. Consulte o OpenAPI para os
campos e erros. Falhas de coleta não alteram conexão, filas ou entrega de mensagens.

## Reiniciar serviços

Clique no card atual, exceto **Total**, e escolha **Reiniciar serviço** nos detalhes. O clique abre uma
confirmação com nome e executor (**Docker** ou **systemd**); só **Confirmar reinício**
solicita a ação. Cancelar ou abrir um gráfico não reinicia nada. Disponível apenas
para administrador Manager ou token global. Instâncias antigas/medições S3 não
habilitam reinício. Sem agente configurado, o botão fica desabilitado e o painel
mostra como configurar. Reiniciar pode interromper sessões/conexões; não altera
imagem, volumes, bancos ou configurações. Não faz deploy nem remove hostpaths.

### Controle separado do web

É necessário um pequeno agente independente, fora do processo/container/unidade
que será reiniciado. O web só chama esse agente por rede privada; **não monte o
socket Docker no web**. O agente usa uma lista estática de alvos permitidos,
arquivo e diretório de estado não graváveis pelo web. Não aceita comando shell,
URL, nome de container ou unidade enviados pelo navegador. A lista associa o
`component` real de `GET /admin/resources` ao container ou unidade systemd.
Configure `RESOURCE_METRICS_INSTANCE_ID` único/estável no processo para manter a
associação ao recriar containers ou reiniciar processos nativos. Redis e RabbitMQ
usam os IDs do resumo; VoIP também precisa manter o ID publicado ou atualizar a
lista explicitamente. Não derive o alvo automaticamente de nome parecido.

No **web**:

```dotenv
SERVICE_CONTROL_URL=http://127.0.0.1:9880
SERVICE_CONTROL_TOKEN=<segredo-aleatorio-dedicado-com-pelo-menos-32-caracteres>
SERVICE_CONTROL_GUARD_TOKEN=<outro-segredo-aleatorio-diferente>
```

No **agente** (mesmos dois segredos, não uma senha SSH ou SIP):

```dotenv
SERVICE_CONTROL_BIND=127.0.0.1
SERVICE_CONTROL_PORT=9880
SERVICE_CONTROL_GUARD_URL=http://127.0.0.1:9876/internal/service-control/safety
SERVICE_CONTROL_TARGETS_FILE=/etc/viperconnect-control/targets.json
SERVICE_CONTROL_STATE_DIR=/var/lib/viperconnect-control
SERVICE_CONTROL_SYSTEMD_UNIT=viperconnect-control.service
```

Inicie `node dist/src/services/service_control/standalone.js`. O diretório de estado
é obrigatório, persistente, exclusivo do agente e deve permitir escrita. Os dois
segredos têm no mínimo 32 caracteres e devem ser diferentes. Nunca publique a
porta do agente; use loopback/rede privada restrita ou TLS externo. Os tokens não
são enviados ao navegador, a URLs, logs ou S3. O callback interno só aceita o
segredo de verificação e retorna booleano/data, não dados das sessões.

Lista de exemplo (substitua o hash pelo ID **real**, não use este valor fictício):

```json
[
  { "component": "aaaaaaaaaaaaaaaaaaaaaaaa", "name": "Worker Zapo", "backend": "docker", "target": "viperconnect-worker-1" }
]
```

Em Docker Compose standalone, monte `/var/run/docker.sock` **somente no agente**,
e um volume exclusivo para `/var/lib/viperconnect-control`. O socket permite
controle equivalente a root no host; `:ro` não torna as chamadas Docker somente
leitura. Isole o agente, não exponha sua porta e proteja seus segredos. Exemplo
no repositório: `docs/examples/compose.service-control.yml`. Reinicia o **ID exato**
inspecionado (`stop` com prazo de 30s e depois `start`); não recria container.
Docker Swarm é recusado explicitamente: este agente **não** atualiza serviços,
tasks ou réplicas do Swarm. Containers parados também não são iniciados por ele.

No Linux nativo, use alvos `backend=systemd` e `target=viperconnect-worker.service`.
Executa somente `/usr/bin/systemctl show` e `restart`, com argumentos fixos, sem
shell. O agente precisa de permissão administrativa para essas unidades; o web
continua sem root/sudo. Exemplo de unidade em `docs/examples/viperconnect-control.service`.
Arquivos de configuração devem ser do administrador, modo 0600; o agente nunca
deve ser incluído entre os alvos que ele próprio reinicia. Não suporta PM2,
supervisord, Windows services ou comando livre. Um agente controla um host;
não há descoberta automática de hosts remotos.

### Barreiras e acompanhamento

Antes da ação, o agente consulta o web e **recusa** se houver chamada Zapo,
ramal nativo ocupado, trava de roteamento VoIP, tarefa sem ACK no RabbitMQ ou
migração/backup/restauração/trava de rotação ativa. Redis, VoIP configurado ou
Management indisponíveis, leitura inválida ou orçamento de varredura excedido
também bloqueiam: não existe botão “forçar”. Usa consultas limitadas, sem ler
conteúdo de mensagens ou tirar mensagens de filas. Filas prontas/agendadas não
bloqueiam por si sós. A checagem é **pontual**, não uma manutenção global atômica:
uma chamada/tarefa nova pode começar depois da leitura. Faça isso numa janela
sem uso e não inicie trabalho durante a confirmação. Não garante dreno coordenado
de múltiplos hosts nem preservação de uma operação iniciada nesse intervalo.

A confirmação assinada vence em 60s e é vinculada à instância corrente. Se o
container/unidade foi reiniciado/recriado, a ação é recusada. O ID da operação é
gerado **antes** do POST; cliques repetidos com o mesmo ID não repetem o reinício.
**Consultar operação** só faz GET. O navegador conserva esse ID na aba para
recuperar o acompanhamento ao recarregar após reiniciar o próprio web; pode ser
necessário autenticar novamente. O agente mantém as últimas 200 operações em
`operations.json`, sem depender do Redis/S3 (inclusive ao reiniciar o Redis), e
emite auditoria com administrador, alvo, executor, datas e estado, sem segredos.
Proteja e monitore também esse diretório; não é um backup das sessões.

O VoIP configurado precisa expor também `GET /v1/console/backups/capability`;
a verificação recusa reinício quando o próprio VoIP informa restauração ativa,
inclusive se uma trava Redis já expirou. Versões sem essa confirmação são
tratadas como verificação indisponível, sem reinício forçado.

Estados: `accepted`, `restarting`, `running`, `failed` (recusa antes do comando)
ou `unknown` (resultado incerto depois do comando/interrupção). Um comando
incerto **não é repetido automaticamente**. O agente aguarda até 120s após o
comando pela nova instância em execução; se houver healthcheck Docker, exige
`healthy`. Sem healthcheck/systemd, **processo rodando não confirma saúde da
aplicação, áudio nem sessões Online**. Se o agente cair, as operações pendentes
ficam incertas. O arquivo exclusivo `agent.lock` impede dois agentes no mesmo
estado: após queda abrupta, confirme que não existe agente em execução e
preserve/inspecione o journal antes de remover **somente** essa trava e subir
novamente. Nunca apague o diretório ou reenfileire comandos para “resolver”.

API do painel (administrador; `no-store`):

- `GET /admin/resources/control`: capacidade, executor, motivo e confirmação assinada.
- `POST /admin/resources/{component}/restart`: `operationId` UUID v4, `confirm` igual ao component e `confirmation` obtida na consulta; retorna 202, não conclusão.
- `GET /admin/resources/operations/{operation}`: estado persistido, sem novo comando.

Erros relevantes: 400 contrato inválido; 403 sem administrador; 404 alvo não
permitido/operação ausente; 409 instância/confirmação alterada ou agente ocupado;
503 agente/diário indisponível. Recusas da verificação aparecem no resultado da
operação (`control_calls_active`, `control_storage_busy`, `control_jobs_active`,
`control_safety_unavailable`); callback interno retorna 423 nesses casos.
Configurar/validar em DEV não publica imagens nem aplica a função em produção.

## Logs ao vivo e exportação

Clique no card atual para abrir os detalhes; ali há **Logs**, ao lado de **Reiniciar serviço**. Abre um
visualizador somente leitura, exclusivo do administrador, com layout desktop e
mobile. Usa o mesmo agente e a mesma lista explícita de serviços; não precisa
montar socket Docker no web, instalar leitor Redis, conceder shell ao navegador
ou reiniciar o serviço observado. Atualize também o agente para habilitar o botão.
O total e a lista de instâncias antigas não oferecem leitura. Um serviço atual
parado ou com medição atrasada pode ter logs: a disponibilidade da leitura não
depende de estar Online ou do bloqueio de reinício.

### Filtros e uso

- **Linhas recentes**: 100, 300 (padrão), 1.000 ou 2.000 linhas brutas recentes,
  seguidas das novas linhas em fluxo contínuo HTTP, não consultas repetidas.
- **Incluir palavras** aceita qualquer um dos termos separados por vírgula;
  **Excluir palavras** remove linhas que contenham qualquer termo informado.
  Até oito termos/200 caracteres por campo, sem diferenciar maiúsculas e sem regex.
  Espaços internos fazem parte do termo; vírgula é o separador. **Aplicar filtros**
  abre um recorte novo, limpando a visualização anterior.
- **Nível mínimo** usa Pino, prioridade do journal ou marcadores textuais quando
  identificáveis. Error inclui Fatal; Warn inclui Warn/Error/Fatal. Linhas sem
  nível só aparecem em **Todos**. `stderr` não significa automaticamente Error.
- **Canal** seleciona `stdout`, `stderr` ou `journal`. Docker com TTY reúne os
  canais em stdout; no Linux nativo a origem é journal, sem inferir stderr.
- **Pausar** cancela a leitura na origem, conservando o que já está na tela.
  **Retomar** tenta recobrir desde o último segundo recebido e deduplica as linhas
  ainda no buffer. Não garante recuperar tudo se houve rotação, mais linhas que o
  recorte, indisponibilidade, perda de rede ou pausa maior que 24h.
- **Rolagem automática** pode ser desativada para ler sem voltar ao fim a cada
  atualização. **Limpar tela** limpa somente o navegador; não apaga logs do host.
- **Exportar exibido (.txt)** baixa as linhas sanitizadas que estão na tela,
  com horário, nível e canal. Não exporta todo o histórico do host nem faz novo
  processamento de arquivo no worker. Ao trocar filtros, exporta só o novo recorte.

O recorte inicial é feito **antes** dos filtros, portanto procurar um termo raro
não percorre todo o arquivo até encontrar 2.000 ocorrências. Não há persistência
adicional de logs em Redis, S3 ou no web. A retenção/rotação continuam sendo as
configuradas em Docker/journald. Abertura, pausa, fechamento, troca de usuário e
aba oculta são tratados: fechar/pausar ou ocultar a aba cancela o leitor/child
daquela tela. Não encerra o serviço ou uma chamada. Voltar à aba exige **Retomar**.

### Limites, privacidade e fontes

O navegador conserva até a quantidade selecionada, no máximo 2.000 linhas e
aproximadamente 1 MiB de conteúdo/metadata estimados; descarta as mais antigas e
mostra o contador. Não é uma medição exata do heap do navegador. A atualização do
texto é agrupada (200 ms), sem recriar toda a tela a cada linha. Não usa HTML dos
logs; conteúdo como `<script>` é texto. A exportação usa somente esse buffer
limitado e libera a URL temporária após baixar/fechar.

Agente e proxy aceitam até **quatro leitores simultâneos**. Cada conexão da fonte
tem limite de **cinco minutos, 8 MiB brutos ou 50.000 linhas**; ao atingir, encerra
com aviso e pede retomada. Não reconecta em loop silencioso. O proxy tem prazo de
segurança de 330s e saída máxima 32 MiB por conexão, sem armazená-la inteira.
São limites de leitura, não de retenção dos logs existentes. Há backpressure e
heartbeat de 10s; o proxy informa `X-Accel-Buffering: no`. Em proxy externo que
ignore esse header, desative buffering para a rota e use timeout maior que o
heartbeat. Não publique a porta do agente para resolver um proxy mal configurado.

Linhas maiores que 32.768 caracteres são omitidas inteiras, sem enviar fragmentos
potencialmente contendo segredos. Tokens/senhas/chaves reconhecidos, Bearer/Basic,
credenciais em URLs e os segredos do agente são ocultados **antes** dos filtros e
da exportação. Isso é sanitização por padrões, não anonimização garantida: logs
podem conter telefones, mensagens, identificadores e segredos sem rótulo que não
sejam reconhecidos. Acesso e exportação são administrativos; proteja o arquivo
baixado e não o publique. Não alteramos o nível de log da stack.

Docker usa o stream de logs da API do daemon vinculado ao ID exato do container;
drivers sem suporte de leitura retornam erro explícito, sem acesso alternativo a
arquivos internos. Linux nativo usa `/usr/bin/journalctl --unit <unidade>` com
argumentos fixos e JSON; requer journald e permissão no agente. Não lê arquivos
arbitrários, PM2 ou supervisord. Mensagens grandes/binárias indisponíveis no JSON
do journal podem aparecer como omitidas (o próprio journalctl limita campos por
padrão); não afirmamos recuperar esses conteúdos. Não há implementação Swarm.
Systemd deve ser validado no host nativo antes de implantar; no DEV Docker a
execução nativa é coberta por provas sintéticas, não reinício/leitura real de host.

API:

- `GET /admin/resources/{component}/logs?tail=300&include=audio&exclude=heartbeat&level=error&channel=all&since=0`, com token administrativo no header.
- No agente privado: `GET /v1/targets/{component}/logs`, com `SERVICE_CONTROL_TOKEN`.
- `GET /admin/resources/control` inclui `logs=true` para alvos com backend de leitura;
  não é confirmação de acesso à fonte até abrir o fluxo.

Resposta `application/x-ndjson`, eventos `connected`, `line`, `heartbeat`, `end` e `error`.
`end` informa fonte encerrada ou limite; falha depois dos headers é evento de erro,
não um log vazio com sucesso simulado. 400 filtros inválidos; 403 não administrador;
404 alvo não permitido; 429 leitores excedidos; 503 agente/fonte/formato indisponível.
A autenticação é verificada ao abrir cada conexão; conexão existente é limitada
no tempo, não reautenticada a cada linha.

Referências do protocolo: [Docker Engine ContainerLogs](https://docs.docker.com/reference/api/engine/version/v1.47/#tag/Container/operation/ContainerLogs)
e [journalctl](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html).
