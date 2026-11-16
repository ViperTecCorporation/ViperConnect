# RabbitMQ and queues

Queue names below use `UNOAPI_QUEUE_NAME=unoapi`. `<server>` identifies the session
server. Zapo session queues end in `.<server>.zapo`, before optional `.delayed` or
`.dead` suffixes.

## Responsibilities and consumers

| Queue | Purpose | Consumer process |
| --- | --- | --- |
| `unoapi.incoming.<server>.zapo` | Sends, status updates, group management and provider operations | Session worker |
| `unoapi.listener.<server>.zapo` | Processes incoming WhatsApp events | Session worker |
| `unoapi.history.<server>.zapo` | Isolated history synchronization processing | Worker: two consumers per process |
| `unoapi.outgoing` | Delivers message webhooks to applications | Broker |
| `unoapi.outgoing.history` | Delivers history webhooks | Broker: two consumers per process |
| `unoapi.transcribe` | Audio transcription | Broker |
| `unoapi.transcribe.history` | History audio transcription, returning to history output | Broker: two consumers per process |
| `unoapi.session.events` | Session lifecycle and heartbeat webhooks | Broker |
| `unoapi.media` | Scheduled deletion of stored media files | Broker |
| `unoapi.video.stage` | Fetches and temporarily stores source video | Video worker or broker |
| `unoapi.video.transcode` | Prepares and converts video before forwarding the send to the session | Video worker or broker |
| `unoapi.bind.<server>.zapo` | Registers session consumers and routing bindings | Worker |
| `unoapi.reload.<server>.zapo` | Reloads session configuration and connection | Worker |
| `unoapi.logout.<server>.zapo` | Session disconnection and logout | Worker |
| `unoapi.reload` | Global reload requests | Web and broker, depending on active processes |
| `unoapi.broadcast` | Forwards internal events to the interface through sockets | Web |
| `unoapi.timer` | Scheduled text sends after timer validity checks | Broker |
| `unoapi.notification` | Error notifications through the message sending flow | Broker, when enabled |
| `unoapi.webhook.status.failed` | Failed message status notices to the configured failure webhook | Broker, when configured |
| `unoapi.blacklist.add` | Temporary or persistent webhook blocks, depending on TTL | Broker |
| `unoapi.commander` | Template commands for bulk sends, reports and webhook configuration | Bulk process, when used |
| `unoapi.bulk.parser`, `unoapi.bulk.sender`, `unoapi.bulk.status`, `unoapi.bulk.report` | Bulk preparation, sending, status and reports | Bulk process, when used |

A queue can remain after a feature is disabled. Check configuration and consumers
before treating it as abandoned. Global `unoapi.reload` is valid, not legacy merely
because it lacks an engine suffix. A consumer count alone does not prove progress.
With `UNOAPI_VIDEO_WORKER_MODE=dedicated`, a stopped video worker leaves jobs waiting;
there is no automatic fallback to the broker. Mode `broker` runs both video stages there.

Video jobs reread configuration before accessing media and before publishing
the next stage. Synthetic/fixture sessions do not download files, access S3 or
run conversion; terminal refusal goes to `.dead` without preparation retries.
An ongoing migration or restore remains a temporary failure subject to the
existing retry policy. Storage-policy refusals do not emit misleading media
failure statuses or webhooks.

### Configuration through template commands

The `unoapi-config` command accepts a YAML object containing public session
configuration fields. It cannot change the provider, owning server/worker, storage
backend or descriptor, store paths, or internal connection, transfer and primary
device lifecycle markers. Those changes must use their dedicated dashboard/API
flows, including storage migration under [Session storage](/en/guide/session-storage).

If any protected field is present, the whole command fails with
`commander_config_protected_fields` before saving configuration or publishing a
reload. A non-object root value fails with `commander_config_invalid`. To preserve
existing behavior, public values `false`, `null`, `0` and empty strings still have
no effect in this command; do not use it to clear or disable an option. Bulk and
webhook commands retain their existing contracts.

## Active, delayed and dead-letter queues

- No suffix: work available for processing. Ready items without consumers require investigation.
- `.delayed`: scheduled execution or retry waiting. Zero consumers is expected;
  message expiration forwards work through the dead-letter exchange to the active queue.
- `.dead`: work that exhausted its retry budget. It requires review, not an assumption of completion.

### Media retention

S3 uploads with scheduled cleanup publish a filename to `unoapi.media.delayed` with
`DATA_TTL * 1000` milliseconds of delay. `DATA_TTL` is measured in seconds and defaults
to **2,592,000 seconds (30 days)**. The environment can override this default.
After expiration, `unoapi.media` invokes `removeMedia`; the S3 adapter uses
`DeleteObjectCommand`. The delayed queue may also contain cleanup retries.

Thousands of items can be normal retention, not pending WhatsApp sends. Check trends,
configured retention, the active consumer, deletion logs and `unoapi.media.dead`.
**Purging discards cleanup tasks, not stored files**, potentially leaving files without
automatic cleanup. `DATA_URL_TTL` controls signed URL validity, not file retention.
Changing `DATA_TTL` affects new tasks, not expiration values already published.

## History isolation

History processing, webhook delivery and transcription have separate queues. Each
stage starts two consumers per owning process, each with its own channel and
`prefetch=1`. These are not new containers. Each replica adds its own consumers.
Filters and payload contracts are preserved. Real-time events may overtake history;
there is no global ordering across queues. CPU, Redis, network and HTTP destinations
remain shared. Before rollback, ensure pending new queues retain compatible consumers;
do not purge them to bypass compatibility problems.

## Publisher confirmations and limits

`amqpPublish` waits for individual RabbitMQ publisher confirms and uses `mandatory`
to detect unroutable publications. Confirmation means RabbitMQ accepted the publication,
**not that WhatsApp or the webhook received it**.
Before acknowledging an original item, retry/dead-letter publication must be confirmed.
If it fails, the consumer channel closes so unacknowledged work can be redelivered.
The confirmation wait is bounded at 30 seconds; uncertain channels are discarded.

This is neither exactly-once nor zero-loss delivery. A crash after acceptance but
before confirmation may produce duplicates. Receivers must use contract identifiers
for deduplication. RPC keeps its own response/correlation flow. VoIP audio does not
travel through these message queues.

## Dashboard metrics and warnings

Administration requires the global administrative token, not a session token.
The backend uses `AMQP_URL`; `RABBITMQ_MANAGEMENT_URL` can override the management
API address. Do not expose credentials in the browser.

In the **Redis** panel, internal families `unoapi-config:`,
`unoapi-session-storage:` and `unoapi-lease:` are read-only, including prefix
operations. Previews show safe metadata only; tokens, backup/S3 credentials and
lease tokens are not exposed. Use the official Sessions and Storage screens to
configure, migrate or restore sessions. The interface also hides mutation
controls when an older response omits `readOnly`. This does not make all legacy
Redis session data read-only or remove confirmation for permitted deletions.

When `CONTACT_SYNC_ENABLED=true`, the web process's contact scheduler discovers
sessions through the shared catalog. SQLite sessions are read in pages on their
owner, covering native contacts and preserved copies with expiry checks and
deduplication by known phone number. Opaque LIDs are never converted into phone
numbers. Redis sessions keep reading their own backend; locks, pending markers
and scheduling deadlines remain in Redis. Periodic and pending synchronization
share the same per-session reservation.

- `messages_ready`: not yet delivered to consumers; delayed items may simply be waiting.
- `messages_unacknowledged` (`unacked`): delivered but not yet acknowledged as completed.
- Consumers: active subscriptions, not container count.
- State: any value other than `running` remains flagged, including delayed queues.

Active queues with ready items and no consumers are flagged, as are nonempty `.dead`
queues. Running `.delayed` queues are not flagged solely for having items and zero
consumers. No warning does not prove correct expiration: compare trends and logs.

## Inspection, purging and recovery

Reading counters differs from inspecting payloads. Dashboard inspection uses
`ack_requeue_true`: it fetches a sample and requeues it, potentially changing relative
order. The newest-first option reverses only that sample, not the complete queue.
Prefer counters when payload inspection is unnecessary.

Purging deletes ready items, not already delivered unacknowledged items. It requires
the queue name for confirmation and can lose work. Do not use it as a generic fix.

**There is no general automatic `.dead` recovery in the documented flow.** The legacy
`waker` utility is not universal recovery for current server/engine queues, history,
video or session events. Before controlled reprocessing, identify and fix the cause,
check payload validity and duplicate risk, and obtain specific operational authorization.

For a read-only diagnosis: identify queue scope and suffix, compare metrics over time,
check the owning process and configured delay without exposing secrets, then correlate
receipt, completion, error and publication logs. Distinguish AMQP publication errors
from WhatsApp errors and HTTP failures. Do not restart services, purge, reprocess or
send synthetic messages as part of a read-only check.

## Related guides

- [Message webhooks](/en/guide/webhooks)
- [Session lifecycle webhooks](/en/guide/session-webhooks)
- [Troubleshooting](/en/guide/troubleshooting)
