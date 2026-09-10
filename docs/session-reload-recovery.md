# Webhook updates and Zapo reconnection

Saving an existing Zapo registration whose only effective changes are webhooks
or overrideWebhooks no longer disconnects the WhatsApp socket. This also covers
idempotent saves. The request must contain a webhooks array; ordinary register
and connect requests retain their reconnect behavior. Changes to provider,
server, proxy or other session settings retain the full reload path.

The Redis config setter already publishes cache invalidation to all processes.
OutgoingAmqp resolves the current webhook configuration for each new event.
Already queued webhook deliveries retain their original destination snapshot.

Manual Zapo reload retires the old client even when it is offline or connecting.
Socket connection/prompt waits are bounded to 60 seconds, pairing-code requests
to 30 seconds, and socket disconnect to 10 seconds. Closing the socket aborts
pending prompt/code waits. These deadlines bound UnoAPI waiting; they do not
claim to cancel internal library I/O. Old socket callbacks are invalidated by
the existing connection generation guard.

These changes address lifecycle failure paths, not a proven upstream cause of
message_unavailable. Automatic Signal-store deletion and message replay are not
introduced. Production validation should save a webhook while receiving texts,
then reconnect a disconnected test session using QR and pairing separately.
Confirm webhook delivery and auth prompt latency, not only online status.
