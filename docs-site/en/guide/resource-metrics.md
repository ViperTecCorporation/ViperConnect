# RAM, CPU and disk usage

On the Manager dashboard, click **Resource manager**, with a monitor icon beside
**Refresh now**. This dedicated screen shows each ViperConnect process (`web`,
`worker`, `broker`, `video` or `all`), Redis, RabbitMQ and the configured VoIP service, without
adding cards to the initial session list. **Dashboard** returns to the initial
screen. Click a card for RAM/CPU/disk
charts with **1 day, 7 days, 30 days, 90 days and Max** filters. Infrastructure
metrics require an administrator or global token, never a session/user credential.

## Reading the numbers

Linux containers use cgroup v2 memory minus `inactive_file`, approximately matching
Docker's operational reading. Details separate process RSS, JavaScript heap, file
cache and total container memory including cache. Unsupported environments use
process RSS instead. Values are shared across sessions, not per-session RAM.

Redis RAM is global Redis process RSS. Allocation, dataset, overhead, peak and
fragmentation are separate; key count is for the selected database. Redis disk is
only AOF size reported by `INFO persistence`: **partial**, excluding RDB and the
rest of the volume. The total deduplicates shared Linux containers and sums only
observed services, not host RAM. Coturn, S3, docs, compilers and unrelated
applications are excluded. Missing components make the total partial.

CPU is cumulative processing time divided by elapsed monotonic time between
samples: **100% = one core**; 250% means 2.5 cores on average. It is not normalized
to host capacity or container quotas. Cgroup v2 covers all container processes,
including children such as FFmpeg; unsupported environments use only the Node
process (`cpuSource=process`). Redis uses global `INFO cpu` counters, not just the
selected database. VoIP follows the same container/process rule. The first sample
after startup or a source change establishes a baseline: **—**, not invented zero.
CPU totals independently deduplicate shared containers and are marked partial
when some services lack CPU readings. They are not total host CPU. Charts retain
mean and largest **observed interval usage**; sub-minute spikes may be missed.
Old readings without CPU stay missing; there is no retrospective backfill.

Disk is measured file size in local data directories, including SQLite/WAL and
local media, not remote bucket size, write throughput or RAM. Shared volumes must
not be added across workers. Filesystem used/total capacity is shared with other
data. Disk scans have a 750 ms/10,000-entry budget and a ten-minute cache; no file
contents or symlink targets are read. Large/inaccessible trees are marked partial.

### RabbitMQ

RAM totals include `mem_used` from running nodes, identifying the server's memory
strategy (`rss`, `allocated` or mixed/unknown), not necessarily whole-container
usage. A stopped node or missing reading makes RAM partial. Details include node
availability, memory/disk alarms and thresholds, queues, connections, channels,
consumers, ready/unacknowledged messages and publish/delivery rates. Operational
counters are **cluster-global**, not session-, queue-prefix- or vhost-specific.

The **Free disk space** chart uses the lowest observed free space across nodes,
retaining minima in rollups. This is not queue/data storage size and is never
added to worker disk sizes. Optional CPU measurements come from the existing
`rabbitmq_prometheus` plugin: runtime delta / wall-clock delta of the Erlang VM,
using matching units, with **100% = one core**. Both `*_seconds_total` pairs and
legacy `*_milliseconds` pairs are recognized; processor counts or scheduler queue
lengths are never treated as CPU%. Node identity must match Management. Startup,
restart, node changes, invalid counters or scrape failures require two fresh valid
samples; CPU stays **—**, not fabricated zero. Alarms/down nodes are highlighted.

The default scrape is internal `/metrics` on port 15692 of the Management host.
`RABBITMQ_PROMETHEUS_URL` overrides the full internal URL, including HTTPS.
Existing RabbitMQ Basic Auth is reused if required, with no redirects, a two-second
timeout and a 1 MiB response cap. No per-object metrics are requested. No Prometheus
server/Grafana installation is required and plugins are not enabled automatically.
Without supported metrics, RAM/queues still work but CPU is unavailable and the
CPU total is partial. In multi-node clusters a single endpoint measures only its
own VM, so CPU is explicitly partial rather than claimed to cover the cluster.

Collection performs two Management GETs and one Prometheus scrape per minute
(`/api/nodes`, `/api/overview` with selected columns, and `/metrics`), never fetching messages or each queue and
never modifying the broker. Credentials come from existing `AMQP_URL`; the default
Management port is 15672/15671. `RABBITMQ_MANAGEMENT_URL` overrides the internal URL.
The account needs node/overview monitoring permission; we neither grant new
permissions nor expose Management publicly. Access failures use archived S3
measurements or remain unavailable, never invented zero. RAM/CPU/free disk follow
the same bounded buffer/S3 archive; extra operational counters are current facts.
See [official monitoring](https://www.rabbitmq.com/docs/monitoring) and
[Prometheus plugin documentation](https://www.rabbitmq.com/docs/prometheus).

## Bounded collection and private S3 history

Processes sample memory every minute regardless of dashboard use. The browser
polls the summary every 15 seconds only on the visible Resource manager screen,
pausing while a detail dialog is open. No metric requests run on the initial
Dashboard; server sampling continues independently. Redis holds a
summary and at most **120 samples per component** (about two hours). Collection
archives immediately, then every 15 minutes; a confirmed upload leaves only about
five recent minutes in the buffer. During S3 failure, the buffer remains bounded,
older samples may be dropped and degradation is visible. Never-archived data
cannot be reconstructed after a long outage.

Existing stack S3 settings are reused. Private JSON objects contain measurements,
timestamps and process names, never messages, phone numbers, secrets or file
contents. The UI displays the prefix:

```text
metrics/v1/<stack>/<component>/hours/YYYY-MM-DDTHH.json
metrics/v1/<stack>/<component>/days/YYYY-MM-DD.json
metrics/v1/<stack>/<component>/months/YYYY-MM.json
metrics/v1/<stack>/index/<component>.json
```

Components are 24-character hexadecimal hashes. Hour files preserve minute
samples, day files preserve hours, month files preserve days and the index stores
months and the last sample. Rollups retain weighted average/peak RAM and CPU, with
a separate CPU observation count (`cpuN`) excluding older samples without CPU, and last
observed disk size. Queries use minute resolution for 1 day, hours for 7/30 days,
days for 90 days and months for Max, with at most 600 response points and extra
aggregation when needed. No retrospective measurements are invented.
Identical in-flight queries are shared. The local cache is bounded to eight
responses for fifteen seconds; at most eight history queries run per web process,
with four concurrent S3 reads per query.

Archived JSON is not automatically deleted. A bucket lifecycle policy limited to
this prefix can shorten retention. During Redis loss, the Manager attempts S3
catalog/latest-sample recovery and historical reads. Recovered values say **Last
measurement**, with their original timestamp and S3 source, never live. If both
sources fail, data is unavailable, not zero. This does not remove the operational
Redis requirement or restore sessions; metrics history is not a session backup.
During complete Redis loss, HTTP access requires the **global stack token**.
`mgr_` credentials still require Redis validation and remain denied when that
validation cannot be performed. S3 fallback never bypasses authentication.

## Configuration

```yaml
environment:
  RESOURCE_METRICS_ENABLED: "true" # default for cloud.js; false disables collection
  RESOURCE_METRICS_STACK_ID: viperconnect # optional; same across this stack
  # Optional stable/unique identity outside containers:
  # RESOURCE_METRICS_INSTANCE_ID: server-1-worker-1
  # Reuse the existing STORAGE_* S3 settings.
```

Stack ID defaults to `UNOAPI_QUEUE_NAME` or `unoapi`. Keep it unchanged to access
existing history. Outside containers the default identity includes the PID; use
a stable unique instance ID across restarts. A changed Docker hostname also
starts a new series. The catalog supports 128 components. No Docker socket or
privileged container access is required.
For the single configured VoIP endpoint, the overview uses the most recently
measured container, not an extra retired instance after recreation. Prior history
remains in S3 and can be queried by its old component ID through the API.

Redis/VoIP/total collection is elected among `web`/`all` processes with a five-minute
Redis lease. Every worker must run the updated code; frontend-only updates do not
instrument older processes. Legacy direct entrypoints do not start collection;
`cloud.js` is the supported entrypoint.

VoIP needs authenticated `GET /v1/resources/metrics` using `VOIP_SERVICE_TOKEN`.
An old/unavailable service shows no measurement or the last archived sample,
never zero. The read-only endpoint changes no SIP, audio, call data or settings.

## API

- `GET /admin/resources`: components, total, source/freshness and storage status.
- `GET /admin/resources/{component}/history?range=1d|7d|30d|90d|max`: aggregated series.
- Direct VoIP: `GET /v1/resources/metrics` with the service token.

ViperConnect endpoints accept the global token or an administrator Manager login.
Responses are `no-store`; invalid IDs/ranges return 400, insufficient privileges
403 and unavailable queries 503. Missing values remain absent/null, never zero.
See OpenAPI for the complete contract. Sampling failures do not affect sessions,
message delivery or queues.
