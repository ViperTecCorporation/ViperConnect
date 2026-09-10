# Presenca periodica Zapo

Cada socket Zapo conectado inicia um pulso de presenca no evento `open` e
repete a cada tres horas. O timer e somente em memoria, usa `unref` e nao
cria filas, cron, chaves Redis ou novas ENVs.

- `markOnlineOnConnect=true`: envia `client.presence.send('available')`.
- `markOnlineOnConnect=false`: envia `available` e em seguida `unavailable`.
  Isso pode tornar a conta brevemente visivel como online; a flag continua
  desabilitando a presenca online permanente. Nao ha espera artificial entre envios.
- Eventos open duplicados nao criam timers adicionais. Fechamento, logout,
  desconexao e perda da lease cancelam o loop; uma reconexao inicia novo ciclo.
- Nao envia durante QR/pareamento ou em sockets substituidos. Envios pendentes
  nao se sobrepoem; se a biblioteca nao concluir um envio, os ciclos sao
  ignorados ate sua conclusao ou substituicao da conexao. Nao se simula cancelamento
  de I/O que a API de presenca nao oferece.
- Erros sao registrados e o proximo ciclo tenta novamente. Falha de restauracao
  de `unavailable` pode deixar a presenca online ate outra atualizacao.

Logs: `ZAPO_PRESENCE_HEARTBEAT` e `ZAPO_PRESENCE_HEARTBEAT_FAILED`.
Sucesso indica conclusao do envio pela biblioteca, nao garantia de retencao
do dispositivo vinculado ou confirmacao de recebimento pelo WhatsApp.

Contrato conferido no `WaPresenceCoordinator` da Zapo 1.8.2.
A causa de desvinculacao apos sete dias nao foi confirmada. A documentacao
oficial menciona uso do aparelho principal a cada 14 dias; o pulso nao substitui
essa exigencia: <https://faq.whatsapp.com/647349420360876>.
