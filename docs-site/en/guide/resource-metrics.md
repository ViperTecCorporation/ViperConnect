# RAM, CPU and disk usage

On the Manager dashboard, click **Resource manager**, with a monitor icon beside
**Refresh now**. This dedicated screen shows each ViperConnect process (`web`,
`worker`, `broker`, `video` or `all`), Redis, RabbitMQ and the configured VoIP service, without
adding cards to the initial session list. **Dashboard** returns to the initial
screen. Click a card for RAM/CPU/disk
charts with **1 day, 7 days, 30 days, 90 days and Max** filters. Infrastructure
metrics require an administrator or global token, never a session/user credential.

### Recreated containers

An instance expires after three minutes without a sample. When a recent instance
with the same server/role exists, the expired one leaves the main cards and stays
under collapsed **Previous instances**, with its archived charts still accessible.
No Redis keys or S3 objects are deleted to fix the list. Healthy parallel replicas
and different servers stay separate. Without recent instances, only the latest
known measurement per server/role remains, never marked live. The grace period
distinguishes delayed sampling from shutdown without accessing Docker.

Automatic grouping uses the default `server · role · hostname` naming format.
Custom labels are not grouped heuristically; a unique stable
`RESOURCE_METRICS_INSTANCE_ID` preserves their series. Current totals exclude old
instances. `/admin/resources` separates `components` from `historicalComponents`,
while per-ID historical queries remain available.

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

## Restart services

Click a current card except **Total** to open its details, then select **Restart service**, with an explicit
confirmation showing the allowed target and executor (**Docker** or **systemd**).
Opening history or cancelling never restarts anything. Only Manager administrators
or the global stack token can authorize it. Historical/S3-only readings cannot
enable restart. Without a configured control agent, buttons are disabled with a
setup notice. Restart interrupts connections but does not change images, volumes,
databases, configuration or hostpath overlays. It is not a deployment.

### Independent restricted agent

Run the agent outside the process/container/unit it controls. The web application
receives **no Docker socket and no systemctl/root privileges**. An operator-owned
static allowlist associates actual component hashes from `GET /admin/resources`
with exact containers or systemd units. Browser requests cannot supply commands,
URLs or target names. Set a unique stable `RESOURCE_METRICS_INSTANCE_ID` for each
process to retain the association across container recreation/native restarts.
Use Redis/RabbitMQ IDs from the overview. Keep VoIP's published ID stable or update
the allowlist explicitly. Do not infer control targets from similar display names.

On the **web**:

```dotenv
SERVICE_CONTROL_URL=http://127.0.0.1:9880
SERVICE_CONTROL_TOKEN=<dedicated-random-secret-at-least-32-characters>
SERVICE_CONTROL_GUARD_TOKEN=<another-different-random-secret>
```

On the **agent**, also configure the same two different secrets, plus:

```dotenv
SERVICE_CONTROL_BIND=127.0.0.1
SERVICE_CONTROL_PORT=9880
SERVICE_CONTROL_GUARD_URL=http://127.0.0.1:9876/internal/service-control/safety
SERVICE_CONTROL_TARGETS_FILE=/etc/viperconnect-control/targets.json
SERVICE_CONTROL_STATE_DIR=/var/lib/viperconnect-control
SERVICE_CONTROL_SYSTEMD_UNIT=viperconnect-control.service
```

Start `node dist/src/services/service_control/standalone.js`. State must be on a
persistent writable directory exclusive to the agent, not writable by the web.
Both secrets must be at least 32 characters and different. Never expose the agent
port publicly; use restricted loopback/private networking or external TLS. Secrets
are not sent to the browser, URLs, logs or S3. The internal safety callback accepts
only its dedicated secret and returns a boolean/timestamp, not session contents.

Example allowlist, replacing the **placeholder** hash with the actual component:

```json
[
  { "component": "aaaaaaaaaaaaaaaaaaaaaaaa", "name": "Zapo worker", "backend": "docker", "target": "viperconnect-worker-1" }
]
```

For standalone Docker Compose, mount `/var/run/docker.sock` **only in the agent**
and a separate persistent state volume. Docker socket access is host-root-equivalent;
`:ro` does not make API calls read-only. Keep the agent isolated and protect its
secrets. Repository example: `docs/examples/compose.service-control.yml`. It restarts
the exact inspected container ID, with a 30-second stop grace period, without
recreating it. Swarm services/tasks are explicitly refused; stopped containers
are not started. One agent controls one host; no automatic remote-host discovery.

For native Linux set `backend=systemd`, e.g. `target=viperconnect-worker.service`.
Only `/usr/bin/systemctl show` and `restart` are used, with fixed argument arrays,
never a shell. The separate agent needs administrative unit permissions; the web
does not. See `docs/examples/viperconnect-control.service`. Protect configuration
as administrator-owned mode 0600. Do not allowlist the agent itself. PM2,
supervisord, Windows services and arbitrary commands are not supported.

### Safety and status

Before invoking restart, the agent asks the web to check Zapo calls, native busy
extensions, VoIP routing locks, RabbitMQ unacknowledged work and active storage
migration/backup/restore/rotation locks. Unavailable Redis, configured VoIP or
Management, invalid responses and exceeded bounded scan budgets refuse restart.
There is no force action. Reads do not remove queue messages or inspect message
contents. Ready/scheduled queue entries alone do not block restart. This is a
**point-in-time preflight**, not atomic global maintenance: a new call/task may
start after the check. Use a quiet maintenance window and avoid new work while
confirming. It does not guarantee coordinated multi-host draining or preservation
of work started within that interval.

Signed confirmation expires after 60 seconds and is bound to the current Docker
or systemd incarnation. Changed instances are refused. A UUID operation ID is
generated before the POST; submitting that ID again never invokes restart again.
**Check operation** uses GET only. The browser keeps the ID in the current tab to
recover status after restarting/reloading the web; authentication may be required
again. The agent keeps the latest 200 operations in `operations.json`, independent
of Redis/S3, including when restarting Redis. Audit contains admin ID, target,
executor, timestamps and outcome, never credentials. Protect the state directory;
this journal does not replace session backups.

Configured VoIP must also expose `GET /v1/console/backups/capability`. Active native
restores refuse restart even if a Redis lease has already expired. Older services
without this confirmation fail closed; there is no forced fallback.

States are `accepted`, `restarting`, `running`, `failed` (refused before command)
and `unknown` (uncertain after command/interruption). Uncertain commands are never
automatically retried. The agent waits up to 120 seconds after invoking restart
for a changed incarnation running, and requires Docker `healthy` when available.
Without a healthcheck/systemd, process running **does not confirm application
health, audio or Online sessions**. Pending operations become uncertain on agent
recovery. `agent.lock` prevents a second agent sharing the directory: after an
abrupt crash, verify no agent is running and preserve/inspect the journal before
removing **only** that stale lock. Never delete the state directory or blindly
replay commands.

Administrator API, with `Cache-Control: no-store`:

- `GET /admin/resources/control`: capabilities, executor, refusal reasons and signed proof.
- `POST /admin/resources/{component}/restart`: UUID v4 `operationId`, component-matching `confirm`, and `confirmation` from the overview. 202 means accepted, not completed.
- `GET /admin/resources/operations/{operation}`: persisted status; no new command.

Errors: 400 invalid contract; 403 not administrator; 404 unknown operation/target;
409 changed/expired confirmation, incarnation or busy agent; 503 unavailable agent
or journal. Preflight refusals appear in the operation (`control_calls_active`,
`control_storage_busy`, `control_jobs_active`, `control_safety_unavailable`); the
internal callback returns 423. DEV implementation/validation does not publish an
image or deploy/restart production services.

## Live logs and export

The entire summary card is clickable. Its details combine charts/period filters
with **Logs** and **Restart service** for current services; operational buttons
are not displayed on the summary grid. Closing Logs or restart confirmation
returns to the same details and retains the selected period/history.

Each current resource detail includes **Logs**, next to **Restart service**. It opens
an administrator-only, read-only viewer with desktop/mobile layout, using the same
restricted agent and static allowlist. Update the agent to enable the button. No
Docker socket is added to the web, no arbitrary file/shell access is provided and
reading does not restart the target. Total/previous-instance cards do not read
logs. Stopped/current services with stale metrics may still have readable logs;
log access is independent of restart safety checks and Online state.

- **Recent lines**: 100, 300 (default), 1,000 or 2,000 raw recent lines plus new
  lines through a continuous HTTP stream, not repeated log polling.
- **Include words** matches any of up to eight comma-separated literal terms;
  **Exclude words** removes any match. Case-insensitive, max 200 characters per
  field, no regex. Internal spaces belong to a term. **Apply filters** starts a
  fresh bounded view, clearing the previous one. Initial tail happens before
  filtering; rare terms do not trigger an unlimited search through old files.
- **Minimum level** uses Pino, journal priority or recognizable text markers.
  Error includes Fatal; Warn includes Warn/Error/Fatal. Unknown-level lines appear
  only under **All**. stderr is not automatically Error. **Channel** selects
  stdout/stderr/journal; Docker TTY combines streams as stdout, native uses journal.
- **Pause** closes the source while preserving displayed lines. **Resume** tries
  from the last received second and deduplicates retained IDs. Rotation, large
  gaps, network outages, tail limits or pauses longer than 24h may lose coverage.
- Disable **Auto-scroll** to keep the reading position. **Clear view** affects
  only the browser, never host logs. **Export displayed (.txt)** downloads only
  the sanitized displayed buffer with timestamp/level/channel, not all host logs.

No extra Redis/S3/web log persistence is introduced; Docker/journald retention
remains authoritative. Closing, navigating away, logout or hiding the tab cancels
that viewer's source/process without stopping the service or calls. Returning to
a hidden tab requires Resume. Browser updates are batched every 200ms and use
text, not log-supplied HTML. It retains up to the selected number, max 2,000 lines
and approximately 1 MiB of estimated text/metadata, showing an eviction counter;
this is not an exact browser heap measurement. TXT generation uses that bounded
buffer and releases its temporary download URL.

Agent and proxy allow four concurrent viewers. Each source connection is bounded
to five minutes, 8 MiB raw input or 50,000 lines, then shows a resume notice rather
than silently reconnecting in a loop. The proxy adds a 330s/32 MiB output safety
limit without collecting an entire response. Backpressure and 10s heartbeat are
used. `X-Accel-Buffering: no` disables compatible proxy buffering; otherwise
configure the external proxy to disable buffering on this route and allow idle
timeouts beyond heartbeat. Do not expose the private agent port as a workaround.

Lines over 32,768 characters are omitted entirely, not partly disclosed. Pattern-
recognized passwords/tokens/keys, Bearer/Basic credentials, URL userinfo and the
agent secrets are hidden before filtering/export. This is **not guaranteed
anonymization**: unlabelled secrets, phone numbers, messages and other personal
data may remain. Treat access/downloads as administrative and protect exported
files. The feature does not change the stack log level.

Docker reads the daemon ContainerLogs stream bound to the exact container ID;
unsupported logging drivers return explicit errors, never fall back to arbitrary
host files. Native Linux uses `/usr/bin/journalctl --unit <unit>` with fixed
argument arrays and JSON; the agent needs journal access. Large/binary fields
omitted by journalctl's default JSON limits are not claimed recovered. PM2,
supervisord, arbitrary files and Swarm are unsupported. Native systemd requires
host validation before deployment; DEV Docker uses synthetic native tests only.

Administrator endpoint: `GET /admin/resources/{component}/logs`, with `tail`,
`include`, `exclude`, `level`, `channel`, `since` (Unix second within the last 24h,
0 for tail only, at most 60s in the future). Private agent equivalent:
`GET /v1/targets/{component}/logs` using its dedicated token. All credentials stay
in headers, not URLs. Capability overview adds `logs=true`, meaning backend support,
not successful source access until opened. Response is `application/x-ndjson`:
`connected`, `line`, `heartbeat`, `end`, `error`. Errors after headers are explicit
events, not successful empty logs. HTTP 400 invalid filters, 403 unauthorized,
404 target not allowlisted, 429 viewer limit, 503 unavailable source/agent/format.
Authorization is checked on opening; a stream is time-bounded, not reauthenticated
for every line. See OpenAPI for the complete contract.

Protocol references: [Docker ContainerLogs](https://docs.docker.com/reference/api/engine/version/v1.47/#tag/Container/operation/ContainerLogs)
and [journalctl](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html).
