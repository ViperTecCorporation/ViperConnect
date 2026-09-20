# RabbitMQ e filas

Este guia descreve as filas do ViperConnect e a interpretação do painel **Filas**.
Os exemplos usam `UNOAPI_QUEUE_NAME=unoapi`. `<server>` representa o servidor da
sessão. No runtime Zapo, as filas de sessão terminam em `.<server>.zapo`, antes
dos sufixos opcionais `.delayed` e `.dead`.

## Responsabilidades e consumidores

| Fila | Responsabilidade | Processo consumidor |
| --- | --- | --- |
| `unoapi.incoming.<server>.zapo` | Envio de mensagens, atualização de status, gerenciamento de grupos e operações do provider | Worker da sessão |
| `unoapi.listener.<server>.zapo` | Processamento dos eventos recebidos do WhatsApp | Worker da sessão |
| `unoapi.history.<server>.zapo` | Processamento separado da sincronização do histórico | Worker: dois consumidores por processo |
| `unoapi.outgoing` | Entrega de webhooks de mensagens às aplicações | Broker |
| `unoapi.outgoing.history` | Entrega dos webhooks do histórico | Broker: dois consumidores por processo |
| `unoapi.transcribe` | Transcrição de áudio | Broker |
| `unoapi.transcribe.history` | Transcrição de áudio do histórico, com retorno à saída de histórico | Broker: dois consumidores por processo |
| `unoapi.session.events` | Entrega de webhooks de status das sessões, incluindo heartbeat | Broker |
| `unoapi.media` | Exclusão programada de arquivos de mídia no armazenamento | Broker |
| `unoapi.video.stage` | Obtenção e armazenamento temporário do vídeo para preparação | Worker de vídeo ou broker |
| `unoapi.video.transcode` | Preparação e conversão do vídeo antes de encaminhar o envio à sessão | Worker de vídeo ou broker |
| `unoapi.bind.<server>.zapo` | Registro de consumidores e vínculos de roteamento da sessão | Worker |
| `unoapi.reload.<server>.zapo` | Recarga da configuração e da sessão no worker | Worker |
| `unoapi.logout.<server>.zapo` | Desconexão e logout da sessão | Worker |
| `unoapi.reload` | Solicitações globais de recarga | Web e broker, conforme os processos ativos |
| `unoapi.broadcast` | Encaminhamento de eventos internos à interface por socket | Web |
| `unoapi.timer` | Envio de texto agendado, após verificar a validade do temporizador | Broker |
| `unoapi.notification` | Encaminhamento de notificações de erro pelo fluxo de envio de mensagens | Broker, quando habilitado |
| `unoapi.webhook.status.failed` | Avisos de status de mensagem com falha ao webhook específico | Broker, quando configurado |
| `unoapi.blacklist.add` | Atualização de bloqueios dos webhooks, temporários ou persistentes conforme o TTL | Broker |
| `unoapi.commander` | Comandos por templates para lotes, relatórios e configuração de webhooks | Processo de lotes, quando utilizado |
| `unoapi.bulk.parser`, `unoapi.bulk.sender`, `unoapi.bulk.status`, `unoapi.bulk.report` | Preparação, envio, atualização de status e relatórios de lotes | Processo de lotes, quando utilizado |

A existência de uma fila não comprova que a funcionalidade esteja habilitada.
Filas antigas podem permanecer no RabbitMQ. Confira a configuração e os consumidores
antes de classificá-las como abandonadas. `unoapi.reload` é uma fila global válida,
não uma fila legada apenas por não conter o nome do motor. A presença de um consumidor
também não garante que o processamento esteja avançando.

`UNOAPI_VIDEO_WORKER_MODE=dedicated` utiliza o worker de vídeo. Se esse processo
parar, os trabalhos aguardam; não há transferência automática para o broker.
No modo `broker`, o próprio broker consome as duas etapas de vídeo.

## Filas ativas, de espera e de falhas

| Variante | Significado | Interpretação operacional |
| --- | --- | --- |
| Sem sufixo | Trabalho disponível para execução | Itens prontos sem consumidor exigem investigação |
| `.delayed` | Trabalho aguardando um prazo de execução ou uma retentativa | Zero consumidores é esperado: o vencimento encaminha o item à fila ativa |
| `.dead` | Trabalho que esgotou as tentativas previstas | Exige análise; não representa trabalho concluído |

As filas de espera usam expiração de mensagens e encaminhamento por dead-letter
exchange. O nome `.delayed` não significa, por si só, erro. O prazo pode representar
retenção de mídia, agendamento ou espera entre tentativas.

### Limpeza de mídias: `unoapi.media.delayed`

No armazenamento S3, salvar uma mídia com limpeza agendada publica uma tarefa com
o nome do arquivo. O atraso é `DATA_TTL * 1000`: `DATA_TTL` é expresso em segundos
e a publicação usa milissegundos. O padrão do código é **2.592.000 segundos (30 dias)**;
a instalação pode configurar outro valor.

Após a espera, a tarefa chega a `unoapi.media`. O broker executa `removeMedia`;
no adaptador S3, isso corresponde a `DeleteObjectCommand`. A fila de espera também
pode receber retentativas de uma limpeza que falhou.

Milhares de tarefas podem ser compatíveis com a retenção normal. Não são milhares
de mídias aguardando envio ao WhatsApp. Verifique a evolução do volume, o prazo
configurado, o consumidor de `unoapi.media`, os registros de exclusão e a fila
`unoapi.media.dead` antes de concluir que há falha.

**Não purgue essa fila para reduzir o contador.** A purga descarta os agendamentos,
não exclui os arquivos do armazenamento, que podem ficar sem limpeza automática.
`DATA_URL_TTL` controla a validade das URLs assinadas e não substitui `DATA_TTL`.
Alterar `DATA_TTL` afeta novos agendamentos; não reescreve a expiração dos já publicados.

## Histórico e isolamento

O histórico possui etapas próprias de processamento, entrega de webhooks e transcrição.
Cada etapa inicia dois consumidores no processo correspondente, com canal próprio e
`prefetch=1`. São consumidores dentro dos processos existentes, não novos containers.
Cada réplica acrescenta seus próprios consumidores; o limite não é global.

As etapas preservam os filtros e contratos das mensagens. Eventos novos podem
ultrapassar o histórico: não há ordenação global entre filas. CPU, Redis, rede e
destinos HTTP continuam compartilhados. Em uma reversão de versão, não deixe filas
novas pendentes sem um consumidor compatível e não as purgue para contornar o problema.

## Confirmação de publicação e limites

As publicações feitas por `amqpPublish` aguardam confirmação individual do RabbitMQ
e usam `mandatory` para detectar mensagens sem rota. A confirmação significa que
o RabbitMQ aceitou a publicação; **não comprova entrega ao WhatsApp ou ao webhook**.

Na retentativa ou no encaminhamento para `.dead`, o consumidor confirma o item original
somente após a publicação confirmada. Se essa publicação falhar, o canal consumidor
é fechado para permitir a reentrega dos itens sem confirmação. A espera pela confirmação
de publicação tem limite de 30 segundos; um canal com resultado incerto é descartado.

Não há garantia de entrega exatamente uma vez nem de perda zero. Uma interrupção
após a aceitação da publicação, mas antes da resposta, pode causar duplicação.
Os destinos devem tratar duplicatas e respeitar os identificadores dos contratos.
RPC mantém seu fluxo próprio de resposta e correlação. O áudio VoIP não é transportado
nessas filas de mensagens.

## Painel: métricas e alertas

O painel requer o token administrativo global. Tokens de sessão não administram filas.
O backend utiliza `AMQP_URL`; `RABBITMQ_MANAGEMENT_URL` permite definir um endereço
alternativo para a API de gerenciamento. Não exponha credenciais no navegador.

- **Prontas (`messages_ready`)**: itens ainda não entregues a um consumidor. Em uma
  `.delayed`, podem estar apenas aguardando o prazo.
- **Não confirmadas (`messages_unacknowledged`, ou `unacked`)**: itens entregues a
  consumidores, mas ainda sem confirmação de conclusão.
- **Consumidores**: assinaturas ativas na fila; não equivale ao número de containers.
- **Estado**: condição informada pelo RabbitMQ. Um estado diferente de `running`
  permanece sinalizado, inclusive nas filas de espera.

O painel sinaliza filas ativas com itens prontos e sem consumidor, além de filas
`.dead` com itens. Uma `.delayed` em execução não fica vermelha apenas por ter itens
e zero consumidores. A ausência de alerta não prova que o prazo esteja correto:
compare métricas ao longo do tempo e confira os logs.

## Inspeção, limpeza e recuperação

Consultar contadores é diferente de inspecionar mensagens. A inspeção do painel usa
`ack_requeue_true`: retira uma amostra e a recoloca. Os itens não são removidos
definitivamente, mas sua ordem relativa pode mudar. A opção de mostrar as mais novas
inverte apenas a amostra carregada, não encontra necessariamente as mensagens mais
recentes da fila inteira. Evite inspecionar payloads quando os contadores forem suficientes.

A limpeza remove itens prontos, não os já entregues e não confirmados. Exige a confirmação
do nome da fila e pode causar perda de trabalho. Não utilize purga como tratamento
genérico de filas grandes ou de erros persistentes.

**Não há recuperação automática geral das filas `.dead` no fluxo documentado.**
O utilitário legado `waker` não é uma recuperação universal para as filas atuais
por servidor/motor, histórico, vídeo ou eventos de sessão. Não o habilite supondo
que resolverá todos os trabalhos pendentes.

Antes de recuperar uma falha: identifique a causa, corrija o destino ou consumidor,
verifique se o payload ainda é válido, avalie duplicações e planeje um reprocessamento
controlado. Recuperação e exclusão exigem autorização operacional específica.

## Roteiro de diagnóstico sem alteração de dados

1. Identifique a fila, o servidor/motor e a variante.
2. Observe contadores, consumidores e estado em mais de um instante.
3. Confira o prazo e o processo responsável, sem imprimir segredos de ambiente.
4. Correlacione os logs de recebimento, conclusão, erro e publicação.
5. Separe falha de publicação AMQP de falha do WhatsApp ou de resposta HTTP do destino.

Evite reinícios, purgas, reprocessamentos e mensagens sintéticas durante um diagnóstico
que foi autorizado apenas para leitura.

## Referências de implementação

As fontes são `src/defaults.ts`, `src/amqp.ts`, `src/broker.ts`, `src/bridge.ts`,
`src/jobs`, `src/services/media_store_s3.ts` e os componentes do painel em
`frontend/pages/queues.ts` e `frontend/domain/rabbit_queue.ts`.
