# Consumo de RAM, CPU e disco

No painel inicial do Manager, clique em **Gerenciador de recursos**, com ícone de
monitor ao lado de **Atualizar agora**. A tela dedicada mostra cada processo
ViperConnect (`web`, `worker`, `broker`, `video` ou `all`), Redis, RabbitMQ e o VoIP configurado.
Os indicadores não ocupam a lista inicial de sessões. Clique no card para
consultar RAM/CPU/disco e os períodos **1 dia, 7 dias, 30 dias, 90 dias e Máx.**.
O botão **Dashboard** retorna à tela inicial.
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
