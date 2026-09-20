---
description: Manager users, persistent account assignments and personal credentials.
---

# Manager users and personal keys

## Safe Redis inspection

Administrators can inspect `manager-identity:{v1}:users`, `names`, `assignments`,
`history` and `keys` in the Redis browser. Clear the session filter to see these
global keys. Only profile fields, assignments, transfer history and API key metadata
are returned; password hashes, digests and login tokens remain hidden.
These previews include `readOnly: true`. Writes and subtree deletion through the
Redis administration API return HTTP 403 (`redis_key_read_only`). Use the Users
screen to manage these records. Stored values are not changed by inspection.

> Local development feature, not deployed. This guide describes the agreed contract; final integration must be checked against the implementation.

## Security boundary

This is limited isolation for new Manager credentials, **not full multitenant security**. At the user's explicit request, legacy OAuth, public QR and socket flows are unchanged. Do not assume those surfaces enforce per-user isolation. Never share the global stack token with ordinary users.

The server derives the role from the authenticated token, not client-supplied role claims or hidden menus. Global infrastructure is admin-only. User VoIP access is limited to owned active calls and lines, plus automatic extensions with verified links, as detailed below.

Users cannot change `authToken`, `storage`, `proxyUrl` or `baseStore`, or view global credentials. The restricted exception is the SIP credential of their own automatic extension, described below. For new user credentials, ambiguous media lookups without a phone are denied; use the explicit-session route within the user's assignments.

## Sign in

Administrators use username `admin` and the stack token as the password. Ordinary users use their assigned username and password. `POST /manager/login` accepts `username` and `password`, returning `token` and `user`. Login tokens last 12 hours. Send `Authorization: Bearer <token>` on authenticated requests.

Use `GET /manager/me` to retrieve `{ user }`. `POST /manager/logout` revokes the current login token (204), not API keys or the stack token. Passwords are stored as scrypt hashes. Personal API keys are opaque random values, separate from passwords.

## Users and assignments

Create users with `username`, `name` and `password`; the server fixes `role: user` and `active: true`. Usernames are lowercased and `admin` is reserved. Passwords contain 8–256 characters. Changing a password invalidates previous logins but does not automatically revoke API keys.

Only administrators list/create users, change their name, password or active state, revoke their keys, and manage account assignments. Disabling a user revokes effective access even if a credential has not expired. Disabling invalidates the login generation: old login tokens remain invalid after reactivation, requiring a fresh login. Existing API keys are suspended while disabled and resume after reactivation only if neither expired nor revoked. Revoked keys are never restored. Disabling does not transfer accounts.

Assign the persistent canonical PN (account phone number) before connecting. Do not use a LID, display name or temporary identifier as the assignment identity. Removing a session preserves its assignment. Reconnecting does not automatically restore webhooks: restoration is manual and requires administrator review.

For an unassigned number, send this to `PUT /manager/assignments/5511999999999`, substituting the real canonical PN:

```json
{
  "user_id": "user-id",
  "expected_owner": null
}
```

To transfer, set `user_id` to the new owner and `expected_owner` to the observed current owner's ID. To release, use `user_id: null` with the observed owner. Both fields are required.

Ownership changes use atomic compare-and-swap (CAS). If another administrator changed the assignment, the conflict dialog must allow review of the updated owner. Reload and confirm intent before retrying; never silently overwrite `expected_owner` or automatically retry a transfer. The assignment listing includes the mapping and history.

## Personal keys and passwords

Each account lists and manages only its own keys. All `/manager/keys` operations (list, create and revoke) and `POST /manager/password` require a login token, not an API key. Create one named key per integration. API key expiry defaults to 90 days and is capped at 365 days; this differs from the 12-hour login lifetime.

Store keys in a secret manager, never in URLs, logs or documentation. Revoke keys when an integration is retired. Change your password with `current_password` and `password`; an API key is not a password.

Key creation returns 201 with `{ token, key }`; save the secret at creation. Listing returns `{ keys }` without the secret. `days` must be a number greater than zero and no greater than 365. Administrators use the stack token: personal-key creation and password changes through these routes return 403 for them.

## VoIP in the local checkout

The local implementation permits active-call listings for assigned PNs, plus `accept`, `reject`, `end` and `mute` for an active call whose ownership can be verified. Ambiguous call IDs, another account's number and conflicting session fields are denied. History and recordings require the coordinated update below; global configuration and call origination remain denied. Filtered bootstrap does not grant global configuration access. These restrictions do not change legacy flows.

Confirmed secondary access permits `GET /admin/voip/bootstrap`, `GET /admin/voip/console/bootstrap`, `GET /admin/voip/console/zapo-lines`, `GET /admin/voip/console/extensions` and `GET /admin/voip/console/extensions/{extensionId}/credentials`, always limited to owned PNs and verified links. It also permits `PUT /admin/voip/console/extensions/{extensionId}/sip-mode` only for an owned, unshared `zapo_auto` extension. The strict body is `{ "sipEndpointMode": "extension" }` or `{ "sipEndpointMode": "trunk" }`, with no extra fields; the response is `{ extensionId, sipEndpointMode }`. This exception does not allow generic editing or registration disconnection.

Capabilities are `lines: true`, `automaticExtensions: true`, `extensionCredentials: true`, `extensionSipMode: true`, `disconnectRegistration: false` and `basicInboundSettings: false`. Listings do not reveal passwords. The credentials route requires the exact ID of an owned, unshared automatic extension. Owned automatic extensions in trunk mode remain listed and their credentials remain accessible. Manual extensions, external/shared trunks, ambiguous aliases, incomplete links and group sharing are denied/omitted. Restricted responses exclude shared ICE/TURN credentials.

Registration removal and basic settings remain denied to ordinary users: the upstream uses global aliases/sockets, and generic session updates can alter unrelated routing fields.

### Session-scoped history and recordings

Local contract for a coordinated Uno + VoIP service update, not deployed. The upstream must advertise `capabilities.managerSessionHistoryScope: 1`. Only with verified support can Manager advertise `history: true` and `recordings: true`. An old, missing or incompatible upstream keeps both `false` and denies access, with no global-history fallback.

- `GET /admin/voip/console/history`: retains `page`, `pageSize`/`limit`, `search`, `startDate` and `endDate` filters. Assigned PNs are matched against the stored history `phoneNumber` snapshot; scope and filters are applied and counted before pagination. Totals exclude other sessions; filtering only an already returned page is insufficient.
- `GET /admin/voip/recordings/{recordId}`: verifies ownership of that exact record before returning audio. Another session's record is denied; it is never replaced by a different record sharing its `callId`. No global URL, internal storage URL or object key is returned to the client.

Clients use their normal Manager credential only. `X-Unoapi-Session-Scope` carries an internal JSON PN list between authenticated services; it is not caller authentication, is not a Postman input and does not let callers choose sessions. Uno derives scope from the authenticated identity and validates `scope: { version: 1, phones: [...] }` in history and `X-Unoapi-Session-Scope-Applied: 1` on the upstream recording response before streaming. Failed proof returns 403 `manager_voip_forbidden`, without global data or audio.

The current Manager assignment governs all historical records for that snapshot PN, including records preceding the assignment. Records without a reliable `phoneNumber` are excluded for ordinary users; ownership is never inferred from a shared company, remote contact or current session link. Administrator access is unchanged. Removing a session must not destroy historical access while its assignment persists.

Each new request uses the current assignment. A transfer can deny the previous owner's next request but cannot revoke audio bytes or blobs already delivered to the client.

Updating only the UI/documentation does not enable this feature. Contract validation does not replace integration tests with both compatible versions or a production smoke test.

### SIP revocation boundary

Transferring a Manager assignment denies subsequent reads by the previous owner, but does not invalidate a copied SIP password or disconnect an already registered phone. Assignment transfers preserve connections: they do not automatically rotate passwords or remove registrations. Changing or revoking a Manager token alone does not revoke all external SIP access. For complete external revocation, an administrator must rotate the SIP credential and disconnect registrations through the supported telephony process, then verify the outcome.

## HTTP contract

Administrative routes are available in interactive OpenAPI and Postman, including Redis, RabbitMQ and concrete VoIP console resources. Documentation does not grant access. Writes, deletions, disconnections and call commands affect the real environment: review targets, back up when applicable and send one operation at a time. Do not automatically run the entire collection.

In Postman, use `admin_token` for global administration, `manager_login_token` for own keys/password and `token` for scoped session/VoIP operations. Login needs no Bearer token. Copy the returned token into the appropriate variable; the collection does not automatically log in, call or delete anything. Select a binary file manually for transfer-audio uploads.

These paths have no version prefix. “Own” means the user resolved from the token, not a client-selected user ID.

| Method and path | Access | Known request / result |
| --- | --- | --- |
| `POST /manager/login` | No prior token | `username, password` → `token, user` |
| `GET /manager/me` | Authenticated | Current identity |
| `POST /manager/logout` | Authenticated | Revoke current login (204), not API keys |
| `GET /manager/users` | Admin | List users |
| `POST /manager/users` | Admin | `username, name, password` → created user (201) |
| `PATCH /manager/users/:id` | Admin | `name, password, active` |
| `POST /manager/users/:id/revoke-keys` | Admin | Revoke user's keys |
| `GET /manager/assignments` | Admin | `assignments` mapping and `history` |
| `PUT /manager/assignments/:phone` | Admin | `user_id: string\|null, expected_owner: string\|null` |
| `GET /manager/keys` | Own | List own keys |
| `POST /manager/keys` | Own | `name, days` |
| `DELETE /manager/keys/:id` | Own | Revoke own key |
| `POST /manager/password` | Own | `current_password, password` |

Before release, verify expiry, rejection of client role claims, own-key restrictions with login tokens, effective denial after disabling/revocation, pre-connection assignment, persistence after removal, and concurrent-transfer conflicts. Also verify VoIP restrictions, denial of ambiguous media lookups and protection of sensitive settings. These checks do not establish isolation of the unchanged legacy flows and do not imply deployment or production changes.

## Local test evidence and limitations

Run documentation validation for current page, path and operation counts; historical counts are not proof of current coverage. Unit and contract tests are not a production smoke test.

The service has four optional real-Redis tests enabled by `MANAGER_IDENTITY_TEST_REDIS_URL`. Only loopback URLs are accepted; do not use a remote or production server. The default suite skips them without the variable. On September 20, 2026, all four passed separately against temporary Redis 7.0.15 at `127.0.0.1:16389`, using an exclusive namespace and no `FLUSHDB`. The server was stopped and temporary files removed afterward. Recovery after restart with AOF/RDB and visual browser validation were not tested.
