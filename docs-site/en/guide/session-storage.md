# Per-session storage: Redis and SQLite

Per-session storage separates **local session data** from the **shared control
plane**. Its goal is to move messages and persistent state out of Redis memory
while preserving public message IDs.

This implementation is being validated in development. Publishing code or
documentation does not migrate production sessions. A local SQLite file does
not provide automatic failover to another server.

## Browse and maintain session data

Telephony uses the separate [VoIP backup and restore](/en/guide/voip-backups)
workflow. `.viperstorage` contains WhatsApp session data; `.vipervoip` contains
the VoIP database/configuration and hold audio.

Under **Manage session → Overview → Storage**, administrators can open **Explore
SQLite** or **Session Redis**. SQLite is queried on its owner worker; the Redis
shortcut opens the existing explorer with the session selected. These are not
duplicate copies: shared coordination remains in Redis after data migration.

Select a table and search keys/identifiers, then expand a record to inspect its
content. Search is bounded and paginated, not a message-body search; an empty
page may still have a continuation. Persisted expired rows may remain visible
until maintenance deletes them.

**Create**, **Edit** and **Delete** change database records, not WhatsApp messages.
They require an explicitly offline session, disabled auto-connect, confirmation,
storage mutex/WhatsApp lease and a verified S3 backup before each mutation. The
explorer never disconnects a live session itself. Backup failure prevents writes.
Updates/deletes require the row's `etag`; stale records and generation conflicts
are rejected. There is no automatic retry: inspect the database after a timeout
before repeating. The result identifies the pre-change backup.

The editor accepts JSON fields: strings, numbers or `null`; BLOBs use
`{"utf8":"text"}` or `{"base64":"..."}`. Omitted update fields are preserved.
Uno/provider ID pairs change atomically in both directions or are rolled back.
Incorrect manual data edits may affect history/cache; normal offline restoration
can recover the previous backup.

No arbitrary SQL, schema changes or edits to protected credentials/internal
tables. Protected tables appear in the catalog; secrets/media URLs are redacted,
protobuf has a public preview only, and fields above 64 KiB cannot be edited.
Only an administrator login is accepted, never a regular user or API/personal key.

Routes: `GET /v15.0/{phone}/storage/explorer` and `POST` to the same path
(`action=create|update|delete`, `table`, `generation`, `confirm=true`; update/delete
also require `rowId` and `etag`). At most 50 results and 200 examined records per
page. Cursors are bound to session/database/generation/table/search. The web
process never opens the worker's volume.

## Default behavior and Redis dependency

**New sessions default to SQLite under `/app/session-data`, only when the worker
verifies a mounted, writable persistent volume and a compatible SQLite engine.**
Without that volume, the existing Redis flow continues to work and the panel
shows a configuration warning. The variables below are optional; an ENV assertion
or a directory inside the container is not proof of persistence.

| Configuration | Behavior when omitted |
| --- | --- |
| `SESSION_STORAGE_DEFAULT` | Requests `sqlite` for new sessions; invalid capability falls back to Redis. Set `redis` to retain the old default even with a valid volume. |
| `SESSION_STORAGE_PERSISTENT` | Detects a real mount and tests writing. `true` does not bypass verification; `false` disables SQLite. tmpfs/ramfs/overlay mounts are rejected. |
| `SESSION_STORAGE_ROOT` | Uses `/app/session-data`. May select another persistent worker mount; does not inherit `UNOAPI_BASE_STORE`. |

**Redis remains required even with SQLite enabled. Do not remove the Redis
service or `REDIS_URL`.** SQLite holds local session data; Redis still owns
the shared catalog, configuration, panel/API authorization, worker ownership, leases,
locks, routing and invalidations. SQLite does not replace Redis, RabbitMQ or
S3. Recovery without the previous catalog still needs an accessible target
Redis instance; it is not normal operation without Redis.

- Existing Redis sessions stay on the Redis path; changing the SQLite default
  does not migrate them automatically.
- A new session without valid SQLite configuration, mount or capability uses
  Redis after worker confirmation and displays the configuration warning.
- A worker failure or timeout does not confirm fallback. An unconfirmed new
  selection stays paused with an explicit error, never an empty database.
- A session **already migrated to SQLite** stays there even if the default ENV
  is removed. Losing its volume returns an error, never old-Redis fallback,
  data merging or creation of an empty replacement database.

These rules cover the new per-session architecture in the Redis-backed stack,
not older standalone/file modes with `useRedis=false`. The engine capability
probe may briefly open and close SQLite `:memory:` to check its API/version;
this does not create a session file or move session data to SQLite.

## How to enable SQLite

Add the persistent volume to the **existing Zapo worker service**, preserving
its image, networks, variables and other mounts. These three variables only
make the defaults explicit and may be omitted when mounting at `/app/session-data`:

```yaml
services:
  worker-zapo:
    environment:
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
      SESSION_STORAGE_DEFAULT: sqlite
    volumes:
      - session-data:/app/session-data
volumes:
  session-data: {}
```

This is a fragment, not a complete Compose file. Preserve the owning worker's
explicit, stable `UNOAPI_SERVER_NAME`; do not change session ownership or replace
a volume that already contains databases. If a persistent root already exists,
keep its corresponding path and mount instead of creating an empty volume.
Apply the configuration to the worker and check its capability in the panel.

Administrator: **Session → Overview → Session storage**:

- **SQLite unavailable on this worker.** Open **How to configure** for the
  reason and volume/configuration example. Declaring persistence in an ENV does
  not replace a real mounted, writable volume validated by the worker.
- **SQLite available, but new sessions still use Redis.** Open **How to enable
  SQLite** and apply `SESSION_STORAGE_DEFAULT=sqlite` to the worker without
  changing volumes or ownership. This warning appears when Redis was explicitly selected as the default.

The default applies only to **new** QR and Mobile Primary sessions. Existing
sessions use **Migrate to SQLite** with manual confirmation. Already migrated
sessions stay on SQLite; a missing or invalid volume must fail explicitly,
never create an empty database or silently fall back to Redis.

## Required worker configuration

### Lab safety: synthetic and normal modes

In `compose.lab.yml`, `LAB_STORAGE_SYNTHETIC_ONLY` defaults to `true` and controls
`UNOAPI_STORAGE_SYNTHETIC_ONLY` across lab processes. This global barrier blocks
external effects during storage tests with synthetic data.

Before testing an authorized real session in DEV, review the session inventory
and remove imported production copies with exact scope and explicit approval.
Only then set `LAB_STORAGE_SYNTHETIC_ONLY=false` in the lab's **private** ENV
file and apply that configuration to the relevant processes. Never publish the
file or its secrets. This opt-in disables the global DEV barrier, not session
permissions, confirmations or individual safeguards.

A session marked `sessionStorage.fixture=true` still cannot connect, send or
download real media in normal mode. Never remove that marker to connect a
production copy; remove the copy from the test environment before enabling
normal accounts. Switching modes does not migrate data, resume suspended
sessions or authorize sending test messages.

### Persistent volume

SQLite requires a persistent volume on the owning Zapo worker,
as shown in [How to enable SQLite](#how-to-enable-sqlite).

`SESSION_STORAGE_ROOT` selects the local root. Declaring
`SESSION_STORAGE_PERSISTENT=true` does not replace volume validation.
`SESSION_STORAGE_DEFAULT=sqlite` is the default for new sessions **only when
the worker confirms availability**. Without a valid volume/capability, new
sessions remain on Redis and the panel displays a reason and configuration
example. An already migrated session with a missing volume must fail explicitly:
**never** create an empty database or silently fall back to Redis.

### New sessions, before connecting

QR registration has two phases: first it persists configuration with
`autoConnect=false` and an attempt ID, then asks the owning worker to prepare
the backend. Completion requires a durable receipt for the **same attempt and
owner**, including backend and, for SQLite, database UUID and generation.
Only then does it restore connection intent and dispatch reload. Without a
valid volume the worker may explicitly confirm Redis; a timeout is not fallback
confirmation.

A lost RPC reply may be resolved using the committed receipt, for either SQLite
or intentionally selected Redis. Without that receipt, register returns
`session_storage_provision_unconfirmed` (503) and leaves the session suspended.
Repeating register resumes the pending attempt; it cannot replace confirmed
SQLite with Redis or create an empty database. Concurrent edits are compared
before confirmation, without replacing newer configuration.

Mobile Primary prepares storage **before** reserving the session for auth
import. During import it keeps the session suspended and renews ownership every
15 seconds with a 60-second TTL. Connection is enabled only after checking
credentials and atomically confirming configuration, owner, ownership and device
registration. Retries do not overwrite imported auth or updated keys. An older
partial setup without a confirmed storage selection returns
`mobile_storage_selection_required` (409), preserving data for review. An
already imported primary follows its current database descriptor after migration
or restore, not an old creation receipt.

This default never migrates existing sessions. On startup, suspended QR and
primary sessions do not gain disconnected dummy clients that would incorrectly
block offline backup or restore.

The volume must survive container recreation. Do not use a temporary directory,
a Nextcloud-synchronized folder, or an SQLite file shared across workers over
NFS/SMB. Storage identity is stable and separate from phone presentation and
WhatsApp link generations.

### Legacy connection routes

`/connect/{phone}`, `/sessions/{phone}` and `POST /{phone}/request_code` do not
implicitly register an unknown phone. In the Redis-backed stack, missing
persisted configuration returns HTTP 409 `session_storage_registration_required`.
First call `POST /v15.0/{phone}/register` and wait for the owning worker to confirm
the backend, then request connection/pairing. This prevents an implicit Redis
store from bypassing SQLite selection. Existing registered Redis and SQLite
sessions retain their selected backend and connection flow.

Configuration, owner, UUID, generation and internal receipts are not migration
shortcuts: internal fields are read-only through the API. Commander also rejects
engine, owner and storage/device control changes. Ordinary updates compare the
current configuration before writing and preserve compatible edits; incompatible
changes during migration, import or another edit return a conflict rather than
restoring an old descriptor. Actual changes to connection intent are not
suppressed by debounce: reload is serialized per
session, with only one client initialization at a time.

## Data placement

| Session-local SQLite | Shared Redis |
| --- | --- |
| Persistent Zapo store, messages, contacts and history | Session catalog, owner location and generation |
| ViperConnect copies, UnoID ↔ provider ID, keys and states | Leases, locks, routing and invalidations |
| Selected local indexes, metadata and caches | Authorization, webhook destinations, circuit breaker and coordination |

### What remains in Redis

**SQLite reduces session data held in RAM, but does not remove Redis from the
stack.** For a migrated session, Redis still holds shared information:

- **Session catalog and configuration:** phone, owning worker, backend,
  generation, options and registration/device metadata. WhatsApp credentials
  in the Zapo store belong in SQLite; they are separate from these controls.
- **System access:** users, tokens, panel/API permissions and authorization
  indexes.
- **Coordination:** online/offline state, connection leases, task locks, RPC
  routing and cross-process notifications/invalidations. These controls prevent,
  for example, two workers from claiming the same session.
- **Webhooks:** destinations, delivery controls and circuit breaker. Stack
  message queues remain in RabbitMQ; they are not moved to SQLite.
- **Backups:** catalog, scheduling, reservations and task tracking. Backup
  files and manifests live in S3; the Redis catalog is not the backup file.
- **Shared controls:** sending limits, counters and global indexes.

### Session features that still use Redis

Beyond the shared controls above, the current implementation still keeps:

| Feature | Current persistence and boundary |
| --- | --- |
| Contact/webhook blacklist | `unoapi-blacklist:{session}:{webhook}:{target}` keys, including blocking/removal and TTL, in Redis. Contacts used to resolve phone/LID may be in SQLite, but the block itself is not. |
| Campaigns | `bulk-index`/`bulk-message` scheduling indexes and records in Redis. Reports read message status from the session backend. |
| Interaction timers | `unoapi-timer:{session}:{target}` records in Redis. They are not among migrated data families. |

These features **must not be described as already migrated to SQLite**. A
future change must handle consumers and cross-process coordination, preserve
TTL and provide migration/tests; moving keys alone is not enough.

The `.viperstorage` backup **does not include the blacklist, campaign
indexes/scheduling records or these timers**. Restoring that file alone does
not recover these records; also preserve the [global Redis backup](#global-redis-backup-to-s3).
It contains data from sessions that still use Redis as well as global controls.
Enabling SQLite as the default does not automatically migrate existing Redis sessions.

Media bytes remain in the configured media store, such as S3; the database
holds references. A phone appearing in a key does not establish session
ownership: global mappings and shared counters serve multiple processes.

API and broker reads reach the owning worker even while its WhatsApp connection
is offline. An unavailable worker/volume returns an error; another process must
not create an empty database. Redis remains required for coordination.

For Mobile Primary, new-session storage preparation runs before credential
import: configuration remains paused, the worker selects a backend according
to its capability, and import follows. For SQLite sessions the HTTP process
does not open the worker's file; auth reads/writes use private owner RPC,
without exposing credentials to the browser or logs. Linked-device history
reads use bounded local SQLite index pages while preserving IDs, revocations
and expiration. Registration/device metadata and coordination remain separate
in Redis and must also be covered by backups. Synthetic integration tests do
not establish successful linking on a real phone.

Contacts needed by the broker, blacklist phone/LID resolution and Status-reply
context are read on the owning worker; this does not move blacklist blocks to
SQLite. The web process does not open its local SQLite file.
Synchronization walks bounded pages of native contacts and local references,
honors expiry and deduplicates phone numbers without guessing PN from LID.
Receipts, edits and outgoing statuses update local projections while preserving
monotonic status and earlier expiration deadlines. `sent` is persisted after
provider ACK even without a configured webhook. If that write fails, task
redelivery may repair it using IDs and a key already persisted, without another
send; it does not rebuild missing mappings or establish `delivered` or `read`.
Real-time delivery uses Redis only as an invalidation bus: session, conversation,
ID and safe public status,
never message bodies, media or credentials. Subscription authorization is
revalidated before every event sent to the browser.

Local username → LID and Status-recipient indexes also follow the selected
backend. Hashes, sorted sets and selected profile-picture caches must not be
recreated in Redis after migration. Remote operations use a narrow internal
protocol limited to the session phone and allowlisted data families.

Messages-tab media keeps its existing route and accepts a provider ID or its
UnoID alias on both Redis and SQLite. The alias requires valid reciprocal
mappings in the **same session**. Missing or expired references are not rebuilt
by scanning; inconsistent mappings return an explicit error. Revoked, expired
and view-once content is blocked through both IDs before cache reuse. For
SQLite, the owning worker reads its local record and reuses the S3 object.
A cache miss uses the official streaming Zapo download into the
configured S3 store. RPC carries only an internal object key, MIME type and name;
the HTTP process streams bytes from shared storage without opening the worker
database. Without shared S3 it returns `session_storage_media_requires_shared_s3`.
Fixtures cannot trigger downloads. Concurrent requests through both IDs share
one download without resending the message. This route has no additional
conversation identifier.

Video tasks revalidate owner, backend and generation before accessing media and
before returning work to the queue. Fixtures, synthetic mode and
`migrating`/`restoring` transitions block these effects. This does not make
`autoConnect=false` alone a general video-processing barrier.

Unlinking an SQLite session clears native credentials and connection caches but
keeps history, contacts, UnoID ↔ provider ID mappings and the file. Configuration
receives an internal unlinked marker. Only that offline state, with automatic
connection disabled and no active primary, allows a new register request to
change the QR profile or pairing type. Applications cannot submit the marker;
it does not authorize a worker/provider change. Full Mobile Primary removal
cleans credentials on the owner, then atomically deletes device registration
and detaches the retained configuration with generation/lease guards. Suspending
a primary integration remains a separate operation.

## Manual migration in the panel

Do not migrate during a call. Before disconnecting, the worker closes call
admission and checks live calls and in-flight VoIP operations. A starting,
ringing, connected or held call fails the migration task with
`session_storage_active_calls` (409), without ending the call, copying data or
changing the backend. Refused attempts reopen admission. During an admitted
migration, new call commands fail explicitly; live calls are not transferred
between stores.

Administrator: **Session → Overview → Session storage → Migrate to SQLite**.
The panel checks storage capability and ownership before confirmation.

1. The task reserves the session, closes new work admission and drains accepted
   events, including media processing while the socket is still available.
   Only then does it disconnect transport, without remote logout.
2. After rechecking configuration and generation, it marks the transition,
   prepares a local database and copies records, retaining bytes,
   authors, conversations, IDs and expiration deadlines.
3. It validates integrity and publishes the new catalog generation.
4. Uploads an unencrypted `.viperstorage` S3 backup and verifies it through readback, temporary
   restore, hash and SQLite integrity checks.
5. While still offline under the same lease, removes unchanged source Redis
   keys. Configuration, locks and coordination remain shared.
6. Only task completion confirms migration. An accepted HTTP request confirms
   neither migration nor WhatsApp connection or delivery.

Migration, restore, logout and reload share per-session exclusion. Conflicting
requests fail explicitly instead of clearing auth or deleting another task's
lease. Connection setup rereads configuration after asynchronous work and
revalidates generation and ownership before opening the socket. A failed or
timed-out drain prevents copying; it cannot be reported as a complete snapshot.

### Resuming the connection after migration

Before pausing, the worker captures whether the session should resume. It is
eligible only when `autoConnect=true`, its previous status is `online` or
`connecting`, **and** a local client exists on the owning worker. A standalone
Redis `online` marker does not authorize reconnection. Previously offline
sessions and fixtures are not resumed; the global external-effects guard also
blocks this workflow.

After cutover, verified backup, source cleanup and release of the old connection lease, the
coordinator rechecks ownership, storage identity, generation and configuration.
When allowed, it restores `autoConnect=true` and dispatches a normal reconnect
request. The migration task includes a `result` fragment such as:

```json
{ "autoConnect": true, "reconnect": { "status": "requested" } }
```

`requested` confirms dispatch only, **not that WhatsApp is online**. A socket
state/event must confirm the actual connection. `skipped` means no reconnect
was requested and may include a reason; `failed` means intent restoration or
dispatch failed. On a coordination failure, inspect current configuration
before repeating any action. If dispatch fails, `autoConnect` can remain `true` without a
confirmed connection. This does not roll back the committed SQLite migration
or authorize repeating it; inspect the reason and handle connection separately.

The storage descriptor state, including `offline`, is not the current WhatsApp
socket state. Completing the copy, requesting reconnection and actually
connecting are separate confirmations.

Native table conversion reads bytes and metadata from the already captured
local snapshot, not from a delayed second Redis read. Records that naturally
expired between phases must neither abort migration nor receive a new
lifetime. Missing or invalid content without proven expiration remains an
error; never manufacture replacement messages or change their IDs.

Once the server accepts a valid task, the dialog closes and readable progress
appears in the overview. Request errors, immediately failed/interrupted tasks
or invalid responses keep the dialog open and display the error. This UI change
does not change the task or turn
HTTP acceptance into completed migration.

Automatic task polling is bounded. On an error or polling limit, use **Refresh
task** instead of repeating the POST. Task receipts are read from shared Redis without depending on
the changed generation or owner availability; a receipt is not database health.
An interrupted operation requires catalog and journal reconciliation.
Do not remove the volume or run the same session
on another instance during migration.
In the lab, long tasks require a stable Node worker command. Nodemon hot reload
of `dist` can interrupt a copy without restarting the Docker container. Building
does not reload that stable process; update it through a coordinated manual
restart after its running tasks finish.

A successful migration does not retain a second copy in Redis:
`result.sourcePreserved=false`, `backupId` and `sourceCleanup` report finalization.
Configure a private S3 destination first; new backups need no backup key.
If backup, verification or cleanup fails
after cutover, SQLite remains preserved and offline; the task fails without
requesting reconnection. Changed keys are retained, never forcibly deleted.
Do not repeat migration; inspect the journal and use source finalization after
reconciliation. Older migrations may retain Redis source records; there is no
silent retroactive cleanup. An old source is not valid rollback after SQLite writes.

### Finalizing an older or interrupted Redis source

`POST /{version}/{phone}/storage/source-cleanup` accepts
`{ "confirm": true, "backupId": "BACKUP_UUID", "generation": 3 }`.
This is a separate destructive operation requiring administrator login, an
offline SQLite session with automatic connection disabled, its current
generation, a `ready` backup and the migration snapshot. It first downloads and
restores the backup package in a temporary directory and compares the SHA-256
digest of its fingerprint table with the current database. Each atomic Redis
batch then rechecks catalog, generation, ownership token, manifest, source
SHA-1 and expiration before `UNLINK`. Keys whose data or TTL changed are retained
and counted as divergent. Catalog, coordination, global keys and SQLite are
outside the deletion scope.

Follow the task to completion; HTTP acceptance does not confirm deletion.
Compared key bytes are not RSS immediately returned to the operating system.
Never trigger cleanup on timeout or disconnection. This endpoint recovers older
or interrupted finalization; new migrations apply the same guards automatically
after verified backup and before reconnection.

## Disconnecting does not delete history

Suspending a connection, removing a WhatsApp link and permanently deleting a
session are different operations. Disconnection must not remove the SQLite
file or historical UnoID ↔ provider ID references. Clearing link credentials
does not authorize deleting ViperConnect history tables.

Message retention still applies: preserving data on logout is not infinite
retention. Migration keeps original `expires_at`; it does not grant another
30 days to old records. Permanent deletion needs explicit authorization and a
backup policy.

### Maintenance and interrupted tasks

The owning worker runs maintenance at startup and every 60 seconds, without
overlapping cycles. Each eligible SQLite session has a budget of at most 500
expired rows per pass. Foreign owners, fixtures, locked tasks and active
jobs/events are skipped. Auth, Signal and other cryptographic keys are outside
pruning; tombstones and retention policy remain intact. No automatic `VACUUM`
runs: freed pages may be reused internally, but this promises neither a smaller
file nor RAM returned to the operating system.

The same coordinator inspects interrupted transitions and pending journals
without connecting, replaying, promoting files or deleting source data. It
repairs metadata only when identity, generation, files and ownership establish
a safe result. An unverified Redis source, a promoted file or an ambiguous phase
remains `recovery_required` with an explicit review action. Failed post-cutover
source cleanup still requires verified finalization. Panel GET requests only
read receipts; observing status never starts maintenance or recovery.

## Backup and recovery

### Through the panel, without a terminal

Only signed-in administrators may generate, download or restore these archives.
Under **Manage → Overview → Session storage → Backup options**, choose
**Generate backup**. **Backup and restore** offers authenticated downloads of
the latest archive and available weekday backups, without public S3 links or
credentials in URLs.

To move an archive to **another server**, open **Session backups → Restore
session** on the destination and select its `.viperstorage` file:

1. Enter the archive's phone and select an available SQLite worker.
2. Confirm that the origin is paused and will not connect simultaneously.
3. Start restoration and follow its task; uploads are limited to **256 MiB**.
4. After success, **Manage restored session** opens the configuration without
   connecting. Review credentials and integrations before enabling connection.

**Does the archive recreate SQLite on a server without this session? Yes.**
A valid package recreates the SQLite file on the worker's persistent volume
and the required session records in the destination Redis, recovering the
credentials, messages, contacts and ID references included in the backup.
You do not need to copy a separate `.sqlite`, manually register the phone or
scan another QR before importing. The recovered session stays offline with
webhooks disabled until reviewed.

**An absent server registration is not the same as an unlinked WhatsApp device.**
If the device was removed under **Linked devices** on the phone, its
credentials may have been revoked. Restoring a backup does not undo revocation;
new pairing is required in that case. Reusing the link without a QR depends on
the restored credentials still being accepted by WhatsApp.

The destination must have no existing session or conflicting related identity.
Do not register or scan another QR before importing. Recovery preserves IDs
and history, assigns a new storage UUID/owner, and leaves `autoConnect=false`,
offline and webhooks disabled. This complete recovery preserves the snapshot's
session API token: review or rotate it through an authorized operation. Media
bytes remain in S3 and must be accessible on the destination; the archive does
not copy them. The confirmation does not remotely verify that the origin is
stopped. A shared Redis still containing the session causes a conflict, not an
automatic owner transfer. Do not delete its catalog to force recovery.

This global form creates an **absent session**. The **Restore backup file**
button inside an existing SQLite session instead requires it to be paused,
offline and with auto-reconnect disabled; it does not overwrite an active
registration. Redis `.vipersession` and `.viperdevice` keep their own workflows.
The duplicate legacy transfer section is hidden for SQLite sessions.

HTTP 202 is acceptance, not success: wait for `ready`. Failure or an ambiguous
reply does not automatically upload or restore again. Check the existing task
before retrying; preserve recovery identifiers if a file was already promoted.
No restore starts a connection, call or message replay.

The destination must run this code with working Redis, S3 and a persistent
SQLite volume. Authorized worker names come from `UNOAPI_SERVER_NAME`, persisted
session owners and optional `SESSION_STORAGE_RESTORE_WORKERS=worker_1,worker_2`.
These are names, not URLs or local paths. RPC checks the actual worker's
capability; workers without a volume or currently unavailable cannot be used.
Orphan uploads receive bounded eventual cleanup after 24h, excluding active jobs.

Administrative contracts: `GET /manager/storage/workers`,
`POST /manager/storage/restore-upload`,
`GET /manager/storage/restores/{phone}/{id}`,
`GET /manager/storage/{phone}/backups` and
`GET /manager/storage/{phone}/backups/{id}/download` (`id` also accepts `latest`).
The POST takes the phone, owner and confirmation in its query, a raw
`application/octet-stream` body and exact `Content-Length`. It does not accept
local paths, arbitrary S3 URLs, passwords or keys from the browser.

The panel supports a manual backup task. Scheduling uses
`SESSION_STORAGE_BACKUP_ENABLED=true` and
`SESSION_STORAGE_BACKUP_INTERVAL_HOURS=12`. Configure the stack's S3-compatible
destination. **New backups are unencrypted and need no key or password**, even
when a legacy key is already configured on the worker. A `.viperstorage` package
contains credentials, configuration and history: keep the bucket and files
private, restrict permissions and use secure transport. Integrity checks do not
provide confidentiality or establish trust in a file from an unknown source.
A missing destination or failed verification must produce an explicit error,
never simulated success.

The lab Compose enables this SQLite-session routine by default.
Startup and subsequent attempts use two coordinated
12-hour UTC windows. Reservations renew during upload; failure permits retry in
the same window without recording success or allowing overlapping backups.
Fixtures are excluded. `backupPolicy` in storage status and the panel's technical
details expose schedule state and last success/error without secrets. Production
must enable the routine separately; changing the lab does not deploy to the VPS.

### Compatibility with older backups

Existing encrypted backups remain readable with the **same key** used when
creating them. `SESSION_STORAGE_BACKUP_KEY_FILE` is optional for new formats
and serves legacy reads. If the key file and configuration already exist on
the worker, **preserve both**; do not delete, regenerate or replace the key when
adopting the new format. Keep a secure copy outside the worker for legacy
backup recovery.

Without the matching key, restoring an older encrypted file fails explicitly;
this does not prevent creating or restoring new keyless packages. Never submit
a key or password in the browser, HTTP payload, command arguments or logs.
Mobile Primary and other services have separate keys: removing backup encryption
does not remove those services' requirements.

### Weekly rotation and S3 location

In the lab, `SESSION_STORAGE_BACKUP_ROTATION=weekly` selects **seven slots, one
per weekday**. `SESSION_STORAGE_BACKUP_TIMEZONE=America/Cuiaba` determines the
weekday; use a valid IANA time zone. Scheduling still uses 12-hour UTC windows:
the slot time zone does not change that interval. Without `weekly`, policy is
`retain-all`, not automatic age-based deletion.

Each newly verified backup can replace the same weekday's pointer, including
the second daily run. There are seven canonical recovery points, **not**
fourteen guaranteed archives or a minimum seven-day retention period.
The new object is verified and published first;
unreferenced archives are retired afterward under locks and a safety grace
period. Failures preserve the previous slot; uploads, verification and delayed
cleanup may temporarily retain more objects. The same policy can cover global
Redis backups in a separate namespace. Do not configure an incompatible S3
lifecycle that deletes archives still referenced by slots.

The panel shows the effective bucket and prefix without credentials or local
worker paths. A session's objects use:

```text
backups/session-storage/{phone}/{UUID}.viperstorage
backups/session-storage/{phone}/{UUID}.viperstorage.manifest.json
backups/session-storage/{phone}/slots/0.json ... slots/6.json
```

Slots run from Sunday (`0`) to Saturday (`6`) and reference verified manifests.
The archive and S3 manifest can be discovered without the old Redis index.
Protect the bucket and external recovery material, including keys for legacy
archives: a manifest is not a public download authorization.

The package includes SQLite, a session-configuration snapshot and,
for Mobile Primary, the registration/device supplement. It becomes `ready` only
after S3 readback and verified temporary restore. The configuration copy is
recovery material: offline restore does not reapply tokens, webhooks, owners or
automatic connection. Media remains in S3; keys required by Mobile Primary or
other services need separate secure safekeeping, not an obligatory backup key
for the new package format.
Snapshots must be WAL-consistent and accompanied by a versioned integrity
manifest. A raw `.sqlite` file does not replace the `.viperstorage` package;
copying only a live `session.sqlite` file is not a consistent backup either. Redis
backups must preserve the control plane for reconciliation, without blindly
reactivating stale leases or owners.

Older encrypted archives are a preserved exception: rotation does not delete
their files, sidecars or indices when adopting the new format. They may remain
in addition to the seven slots used by new unencrypted archives.

### Offline SQLite restore

The restore endpoint now prepares and publishes a **new storage UUID** for an
existing offline SQLite session, preserving its previous file. It requires
`autoConnect=false`, exclusive ownership, a same-session backup, integrity and
consistent UnoID ↔ provider ID mappings in both directions. The target stays
offline, with no reconnect or replay. The runtime refuses Redis destinations
rather than merging or replacing their data.

The panel can also upload a `.viperstorage` archive through
`POST /{version}/{phone}/storage/restore-upload?confirm=true&mode=offline`.
It requires the same administrator login, an existing offline SQLite target,
`autoConnect=false` and no active client. New packages require no backup key;
only older encrypted archives need their matching key configured on the worker.
Send raw `application/octet-stream` bytes with an exact `Content-Length`, from
1 byte up to **256 MiB**. This is not multipart, JSON, Base64 or a raw `.sqlite`
upload. Never submit a password or encryption key in the request.

The archive streams to private S3 staging. The owner rechecks the target before
validating and restoring into a new UUID; older encrypted archives are also
decrypted using the existing key. HTTP 202 still requires following the task.
Legacy-key, identity, integrity and size failures never become
success or an empty-database fallback. Availability shown in the panel neither
connects the session nor replaces these checks.

For Mobile Primary, the backup registration/device supplement must equal the
current Redis state. A mismatch returns `session_storage_primary_state_changed`;
restore does not overwrite that shared state. SQLite and its Redis supplement
are not a distributed transaction: the routine captures controls before the
snapshot and rereads them afterwards, aborting before upload if they changed,
with at most three bounded attempts. This does not confirm WhatsApp still
accepts those credentials. A loose SQLite file or synthetic backup is not
evidence of real-device recovery.

### Recovery without the previous catalog

Standalone operational recovery obtains the backup package and manifest
from S3 by backup ID or weekday slot, without the previous Redis catalog. It
still requires **an accessible destination Redis with no existing session**,
a persistent worker volume, destination owner identity and S3 access. The new
format needs no `SESSION_STORAGE_BACKUP_KEY_FILE`; preserve and configure the
matching key for older encrypted archives. The source must be stopped: an archive does
not authorize two workers to connect with the same credentials.

The destination uses a new UUID, `autoConnect=false` and disabled webhooks.
It dispatches no connection or replay. Mobile Primary additionally requires
the descriptive device draft, registration and companion state included in
the supplement, plus a valid destination `MOBILE_REGISTRATION_KEY`. Missing or
conflicting material never authorizes generating replacement crypto identity.

With the origin stopped, run inside the destination worker with its environment
configured. These commands require no backup key for the new format; for an
older encrypted backup, configure the key file on the worker, never in command
arguments:

```bash
node scripts/restore-session-from-s3.cjs --phone 5511999999999 --backup-id 12345678-1234-4234-8234-123456789abc --confirm-offline
# Alternative: latest Sunday slot without the previous Redis index
node scripts/restore-session-from-s3.cjs --phone 5511999999999 --weekday 0 --confirm-offline
```

Choose one command, not both for the same recovery. An existing destination is
rejected rather than overwritten. Primary recovery requires imported native
auth (`mobilePrimaryImported=true`) in the snapshot; a draft not yet imported
is explicitly rejected. If failure occurs after file promotion, recovery IDs
allow inspection without guessing rollback or blindly repeating the operation.

Older backups without recoverable configuration or, for a primary, device data
**do not guarantee complete recovery**. This tool does not restore RabbitMQ
queues, missing S3 media, the RDB or the rest of the stack. WhatsApp may have
revoked credentials: archive integrity and synthetic tests do not establish
successful real-device or production recovery.

### Global Redis backup to S3

**Purpose:** this snapshots the entire Redis instance, not one phone. Even
with SQLite sessions, Redis holds configuration, users/permissions, webhooks,
the catalog, coordination and shared references. Data for sessions still using
Redis is included too. SQLite files, S3 media and RabbitMQ queues are not.
To recover one SQLite session, use its `.viperstorage`, not a global Redis restore.

**Restoration:** there is currently no global Redis restore button in the panel.
An `.rdb.viperbackup` is an application archive, not a ready-to-copy `dump.rdb`.
The infrastructure recovery procedure is:

1. Stop services using this Redis and preserve a recoverable copy of its current
   volume. Global restoration may roll back data for every session.
2. Choose the S3 archive and manifest. `prepareRestore` extracts and verifies a
   new staging RDB without replacing the running service.
3. Validate it using a compatible Redis/Valkey version and `redis-check-rdb` or
   its equivalent. Plan activation with Redis stopped.
4. Handle persistence explicitly: **when AOF is enabled, it takes precedence
   over RDB**. Simply placing `dump.rdb` beside old AOF files is insufficient.
   Do not delete the volume to force a reload. Preserve rollback and follow
   the procedure for the deployed Redis/Valkey version.
5. Before starting workers, reconcile the restored catalog, owners, leases and
   tasks. Then start services and validate sessions without message replay.

The routine prepares the file; it does not automatically activate it. Full
stack recovery also requires SQLite volumes and S3 continuity. A global
snapshot is not a cross-server migration and does not authorize simultaneous
active origin and destination.

The coordinator implements this routine, but it is **disabled by default**.
Besides the stack's S3 configuration, activation requires explicit opt-in for
all Redis databases and a compatible executable:

```yaml
environment:
  SESSION_STORAGE_REDIS_BACKUP_ENABLED: "true"
  SESSION_STORAGE_REDIS_BACKUP_ALL_DATABASES: "true"
  SESSION_STORAGE_REDIS_CLI_PATH: /usr/bin/redis-cli
  SESSION_STORAGE_REDIS_BACKUP_INSTANCE_ID: primary-redis
```

New global backups also need no backup key; preserve the existing key for
recovering older encrypted archives. Redis and S3 use `REDIS_URL`,
`STORAGE_ENDPOINT`, `STORAGE_BUCKET_NAME` and the existing S3
credentials; never put passwords in command arguments. A custom TLS CA can use
`SESSION_STORAGE_REDIS_BACKUP_TLS_CA_FILE`.

The routine uses `redis-cli --rdb`, which captures **all databases**, even if the
URL selects one, and requires authorization/ACL for that scope. Snapshotting can
fork Redis and cause copy-on-write RAM peaks; review capacity before enabling
it. Updated Dockerfiles include `redis-tools`, but images must be rebuilt:
the already-running DEV image does not gain the CLI automatically.

A shared claim per 12-hour window prevents duplicate backups across replicas.
Uploaded archives are read back for verification. The backup archive and
manifest use a dedicated S3 prefix: keep objects private and configure lifecycle
retention separately from session media. Global objects live under
`backups/redis/{instanceId}/`: `.rdb.viperbackup` archives, `.manifest.json`
sidecars and, with weekly rotation, `slots/0.json` through `slots/6.json`.
No new global-restore HTTP route is
provided. Recovery preparation only writes a new offline RDB file: it never
runs `RESTORE`, replaces `dump.rdb`/AOF, restarts Redis or activates sessions.
Validate the RDB and reconcile stale leases, owners and tasks before any
operator-controlled activation.

A 12-hour interval provides a **nominal RPO of up to 12 hours** only when every
run succeeds. Backup failures extend that window. Restore, cross-server moves
and Mobile Primary recovery require validation at the destination and exclusive
ownership. An old backup does not guarantee WhatsApp credentials are still
valid. Synthetic validation does not replace authorized real-session tests;
never replay messages during restore.

Existing Redis transfer and device-backup routes must not be advertised as
SQLite-compatible until their adapters and tests are integrated. Publishing
this page does not establish production validation of every recovery workflow.

## Development metrics

The overview shows only backend-relevant indicators: estimated Redis memory
**or** SQLite disk size and record count, alongside shared worker RAM. It does
not attribute exclusive RAM to the session or fill Redis views with unavailable
SQLite fields. UUIDs, generations, diagnostic codes, WAL/SHM, container memory
and other information live in **Technical details**, initially collapsed.
Expansion state survives automatic updates. The operation dialog contains only
its summary, warning, explicit confirmation and action, without duplicating the
overview.
Opening details preserves a checked confirmation; background query responses
do not replace the form. Closing and reopening an operation requires fresh
confirmation. This visual reorganization changes no endpoints, permissions or data.

While the page is active, the panel polls every five seconds. RSS, heap and
external memory belong to the **entire worker**, not one session. SQLite/WAL/SHM
sizes are **disk**, not RAM. Redis memory estimates identify sampled key counts.
Worker RSS and file sizes refresh on every poll. Counts, data estimates and SQL
metadata may be cached for up to 60 seconds; inspect their timestamps and
partial-estimate indicator before comparing values.
Migration timing and before/after storage sizes do not prove memory was freed
when the Redis source is preserved.
The connection-cache budget is **soft**, 1 MiB per open database. Uno and the
SDK share the `node:sqlite` connection; there is no additional 2 MiB SDK cache.
This is neither a per-session RAM ceiling nor observed resident memory usage.
Metrics include the actual SQLite version. The worker requires SQLite 3.51.3 or
later before enabling WAL, including the [WAL-reset fix](https://sqlite.org/wal.html).
An unavailable or old engine also disables capability and keeps new sessions
on Redis with a warning; backup and restore use the validated native SQLite API.

On Linux cgroup v2, the panel also shows container total, anonymous memory,
files/cache, inactive files and kernel memory. These are shared metrics, not
individual costs; do not add them to RSS again. Inactive cache is not guaranteed
free RAM. Loaded client counts exclude offline SQLite databases. A real average
requires stable before/after measurements under equivalent load; an offline
fixture does not size 100 active WhatsApp connections.

## HTTP contract

Operations require an administrator Manager login, not just a phone number,
session token or personal API key. They do not expose local paths, keys,
credentials or message contents.

Storage GET includes `autoConnect`, the known `connectionStatus` and
`restoreUpload.available`, alongside the database descriptor. These fields
help the panel require suspension before upload; they establish neither
WhatsApp delivery nor permission to bypass owner-side operation checks.

`backupPolicy.protection="none"` identifies the policy for new unencrypted
backups. When present, `lastBackup.protection` describes the recorded archive;
its absence in an older receipt does not replace format validation during
restore. These fields neither expose nor request a key.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/{version}/{phone}/storage` | Backend, owner, generation, task and worker capability |
| POST | `/{version}/{phone}/storage/migrations` | `{ "target": "sqlite", "confirm": true }` |
| GET | `/{version}/{phone}/storage/tasks/{taskId}` | Task result; consult before repeating operations |
| POST | `/{version}/{phone}/storage/backups` | `{ "confirm": true }`, verified unencrypted package |
| GET | `/{version}/{phone}/storage/metrics` | Shared process memory and session disk metrics |
| POST | `/{version}/{phone}/storage/restores` | `{ "backupId": "BACKUP_ID", "mode": "offline", "confirm": true }`, restore without connecting or replaying messages |
| POST | `/{version}/{phone}/storage/restore-upload?confirm=true&mode=offline` | Raw `.viperstorage` package, up to 256 MiB; task-based offline restore |
| POST | `/{version}/{phone}/storage/source-cleanup` | Remove verified Redis source only after backup and comparison, with confirmation and generation |

Worker `ready` and gateway-normalized `succeeded` are successful terminal states.
`failed` and `interrupted` do not authorize automatic POST retries. Implemented
workflows remain under DEV validation; this page does not claim production
validation of large-volume restores or real Mobile Primary recovery.

See the [API reference](/en/api-reference) for schemas and responses.

## Worker identity across multiple servers

Each worker with its own SQLite volume needs an explicit, unique
`UNOAPI_SERVER_NAME`, such as `worker_1` and `worker_2`. Queue routing uses this
name, which must remain stable when restarting that worker with its volume.
`UNOAPI_STORAGE_WORKER_ID` must be absent/empty or exactly equal to this name;
a divergent alias is not supported.

```yaml
services:
  worker-zapo-1:
    environment:
      UNOAPI_SERVER_NAME: worker_1
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
    volumes:
      - worker_1_sessions:/app/session-data
  worker-zapo-2:
    environment:
      UNOAPI_SERVER_NAME: worker_2
      SESSION_STORAGE_ROOT: /app/session-data
      SESSION_STORAGE_PERSISTENT: "true"
    volumes:
      - worker_2_sessions:/app/session-data
volumes:
  worker_1_sessions: {}
  worker_2_sessions: {}
```

This is an identity/volume fragment only: preserve the stack's remaining
services, settings, image and networks. Do not create replicas with the same
identity or share a SQLite file between workers. The session's configured
server must match its destination worker; this configuration does not provide
automatic balancing, volume copying or failover.

A divergent alias makes SQLite capability unavailable, and provisioning,
migration and restore are rejected before preparing files. The storage consumer
does not register a queue under an ambiguous identity, without indiscriminately
stopping the legacy Redis worker. This guard validates local configuration;
detecting duplicate container identities or shared volumes remains a deployment
responsibility.

## Private snapshots and session caches

After migration, own-profile and privacy snapshots, cover metadata and profile
picture caches (including misses and webhook intervals) follow the session's
selected backend. The `status-recipients`, `status-media` and
`status-media-recovery` families are copied with their expiration deadlines;
they are distinct from the Redis-only `unoapi-status` connection state.

The temporary cover lock remains in Redis for concurrency coordination. Its
permanent metadata lives in SQLite, while the image object remains in S3.
Snapshots use generation comparisons; cover changes compare the previous
record so that an older operation cannot delete a newer replacement. Calls
from another process are routed to the owning worker. A missing SQLite file
never authorizes rebuilding these values from an old Redis cache. Private cache
operations still using Redis check backend and generation in the same Lua
command as the read or write, so a request started before migration cannot
recreate the old source afterward. Generation changes, an ongoing migration or
a missing SQLite file fail explicitly. Generic cache failures retain previous
tolerance; an already confirmed remote cover mutation returns success with a
metadata warning rather than inviting a duplicate send.

Import and cleanup share the same explicit data-family allowlist. Unknown keys
are neither imported nor deleted automatically. Legacy backups that also
captured `history-sync:{phone}:started` or `webhook-history:{phone}` retain these
Redis controls: cleanup reports them as `retainedControl`, without treating them
as divergent session data or blocking completion. Other out-of-scope records
still count as `skippedScope` and require review; they do not receive a generic
deletion exception.
