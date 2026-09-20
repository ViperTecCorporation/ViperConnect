# Painéis administrativos

O histórico de configurações pode ser consultado na aba **Webhooks** da sessão.
A restauração exige o token administrativo global e mantém os destinos desativados.
Consulte [Histórico e restauração de webhooks](WEBHOOK_HISTORY.md).

O front do ViperConnect oferece painéis para inspeção operacional do RabbitMQ e
do Redis. Ambos usam o token administrativo global da UnoAPI. Tokens de sessão
não têm acesso.

As credenciais nunca são pedidas pelo navegador:

- RabbitMQ: o backend deriva conexão, usuário, senha e vhost de `AMQP_URL`.
  `RABBITMQ_MANAGEMENT_URL` é opcional quando a API de gerenciamento não está
  disponível no host e porta derivados.
- Redis: o backend usa a conexão já configurada por `REDIS_URL`.

## RabbitMQ

O painel **Filas** atualiza a cada 30 segundos, permite busca, filtro por sessão,
explica a responsabilidade de cada fila e destaca em vermelho filas paradas,
filas ativas com mensagens prontas sem consumidor e filas `.dead` com itens.
Filas `.delayed` em execução não exigem consumidor direto: aguardam expiração.
Seu volume, isoladamente, não indica falha. A fila global `unoapi.reload` não é legada.

Veja o catálogo e o roteiro operacional em [RabbitMQ e filas](RABBITMQ.md),
também disponível no menu **Operação → RabbitMQ e filas** da documentação web.
A fila `unoapi.media.delayed` agenda exclusões de mídias; não representa envios
pendentes ao WhatsApp. Purgá-la descarta as tarefas de limpeza, não os arquivos.

A inspeção lê em blocos de 20, até o máximo de 200 mensagens, com
`ack_requeue_true`: os itens são
recolocados e não são removidos, mas sua ordem relativa pode mudar. Campos
sensíveis do payload são mascarados. Filas antigas não possuem timestamp; a
opção “mais novas da amostra” apenas inverte os itens carregados e não afirma
que sejam os mais recentes da fila completa.

A limpeza remove as próximas 1 a 50 mensagens prontas ou todas as mensagens
prontas. Mensagens em processamento (`unacked`) não são removidas. A operação
exige digitar exatamente o nome da fila.

Somente filas pertencentes ao namespace de `UNOAPI_QUEUE_NAME` podem ser
consultadas ou alteradas.

## Redis

O painel **Redis** atualiza a cada 30 segundos e apresenta as chaves em árvore,
com busca e filtro por sessão. A listagem usa `SCAN`, nunca `KEYS`, e retorna no
máximo 1000 chaves.

Somente chaves iniciadas por `unoapi-` ou `unoapi:` são acessíveis. Valores
grandes são limitados para proteger o backend e o navegador; campos sensíveis
são mascarados. Uma chave cujo conteúdo tenha campos mascarados não pode ser
editada pelo painel, evitando substituir o segredo real por `[REDACTED]`.

Criação, substituição e exclusão exigem confirmação literal da chave. O editor
aceita `string`, `hash`, `list`, `set` e `zset`. Coleções vazias são rejeitadas
porque Redis não mantém esses tipos sem elementos.

A caixa de consulta é somente leitura e aceita:

- `SCAN`
- `TYPE`
- `TTL`
- `GET`
- `HGETALL`
- `LRANGE`
- `SMEMBERS`
- `ZRANGE`

Comandos de escrita, administrativos, scripts e chaves fora dos namespaces da
UnoAPI são bloqueados.
