# Isolamento de falhas por destino de webhook

O circuit breaker de entrega usa a sessao e `v2:SHA256([webhook.id || 'default', URL efetivamente enviada])`. A URL e resolvida uma vez antes da verificacao do circuito e reutilizada no POST. O hash evita colocar credenciais ou query strings da URL nas chaves do circuito.

Antes, um ID como `default` compartilhava falhas entre URLs distintas. Jobs antigos preservam seu webhook no payload da fila; apos uma troca de URL, tentativas ao destino antigo podiam bloquear o novo. Agora falhas, abertura, recuperacao e probe half-open ficam isolados pelo destino, tanto em memoria como no Redis.

Nao ha limpeza de filas, alteracao dos destinatarios dos jobs antigos nem replay manual. Chaves legadas nao sao reutilizadas nem apagadas: expiram conforme os TTLs existentes. O primeiro envio de cada destino com a chave v2 comeca sem herdar o bloqueio legado. Jobs antigos continuam sujeitos a politica normal de tentativas.

Validacao: teste de regressao falhou com `WEBHOOK_CB open for default` antes da mudanca. Depois passaram 30 testes em quatro suites: outgoing_cloud_api, webhook_config (service e rota) e webhook_circuit_breaker. Inclui isolamento em memoria e Redis mockado, protecao da URL nas chaves e comportamento half-open existente.

Aplicado somente ao laboratorio por compilacao automatica. Nenhum POST sintetico foi enviado; tentativas normais da fila continuam. Nao foi alterada a VPS.
