# Own WhatsApp profile

## Privacy list dialogs and fallback cache

Opening Privacy queries WhatsApp automatically. A per-session Redis snapshot lasts
24 hours and is used on total/partial upstream failure, with source/date/staleness
displayed. Fallback does not renew old data. Authorization errors never use it.
Confirmed writes invalidate the snapshot and fence older reads. Email/codes and
Status audience are not in this cache. There is no polling.

Selecting “My contacts except” opens a dialog next to the relevant control.
Cancel restores the prior selection; Done stores a draft; Save applies it.
Known lists produce add/remove deltas; an unknown list cannot be edited. Status's
except/only-share-with choices also open a dialog, but replace the complete list.

Name and about share one form and Save button. Only changed fields are sent, using
separate operations; partial failures report confirmed saves. Username remains
read-only. An unavailable lookup means Zapo's `getOwnUsername` failed, not that
the account has no username.

Category IDs are read-only in the panel for safety. Saving company information
never sends or changes categories, including when the field is empty. The category
API contract remains unchanged.

Business hours use one overall mode (specific hours, always open, appointment only)
and a switch per weekday. Disabled days are omitted; time inputs appear only for
specific hours. Existing mixed daily modes are preserved until another overall
mode is chosen. This integration currently supports one interval per day and no
overnight intervals; the panel does not offer additional intervals.

Avatar and cover **Edit** buttons open a dropdown with **Show**, **Upload** and
**Remove**. Show opens a new tab; upload selects a file and still requires Save.
Removal requires confirmation; cover removal requires its stored ID. Direct camera
capture is not implemented.

## Account email (mobile primary only)

**Profile → Account email** provides explicit actions to read status, set an
address, request a code, verify six digits and confirm. This is separate from the
public Business email. Personal and Business mobile-primary accounts may use it;
linked sessions receive HTTP 409. No code is requested or resent automatically.

GET `/{phone}/profile/account_email` returns `email`, `verified`, `confirmed`.
PUT on that route accepts one of these separate requests:

```json
{"value":{"operation":"set","email":"account@example.com"}}
{"value":{"operation":"request_code"}}
{"value":{"operation":"verify","code":"123456"}}
{"value":{"operation":"confirm"}}
```

Use the actual code received by the account owner. Email is limited to 320
characters. Reads go directly to WhatsApp, bypassing the public profile cache;
responses use no-store. Verification state and codes are not stored in that cache.
Authentication and per-session authorization still apply. Email deletion is not
exposed. Invalid/expired codes return 400, unmet prerequisites or unsupported
session mode 409, and lockout/excess attempts 429. Read status before retrying
uncertain writes; never repeatedly request codes in a loop.

## Privacy

Zapo supports last-seen, online, photo and About visibility, read receipts,
group/call/message controls, defense mode, linked Accounts Center profile and Pix
key visibility, contact exceptions, block/unblock and a default disappearing timer
for new chats (off, 24 hours, 7 days, 90 days). Pix visibility is not key registration.
Accepted values depend on the setting/account. **Profile → Privacy** follows account
email on mobile primary and also supports linked sessions. Opening the tab reads
the owning worker; **Read privacy** refreshes manually. Redis supplies fallback
snapshots as described above, without polling. Unknown data stays unknown, not empty or disabled. No writes
occur on opening the tab. Only returned settings are editable. Online offers all
or match-last-seen; the API's `none` is shown only when returned by the account.

GET/PUT `/{phone}/profile/privacy` use normal authentication and session scope.
**Edit exceptions** opens the dialog even from All/Contacts/Nobody and prepares
the exclusion mode as a local draft. Cancel restores the previous selection;
Done stores the draft and Save applies it to WhatsApp. The Status list button
defaults to exclusions unless an inclusion list is already selected. An unknown
exception baseline cannot be edited until a successful refresh.

GET returns `settings`, `blocked`, `exceptions`, `duration`, `warnings`, with
nullable failed sections. PUT wraps a command in `value`: `operation=setting`
with `setting`/`value`; `exceptions` with `setting` and `add`/`remove` arrays;
`block`/`unblock` with `jid`; or `timer` with duration 0/86400/604800/7776000.
Exceptions are deltas (up to 100 IDs per list), accept digits/PN/LID JIDs, and
activate contact_blacklist. The SDK resolves identities and handles version
conflicts. Block/unblock requires UI confirmation. Timer affects new 1:1 chats only.
Changed settings save sequentially; failures identify confirmed writes without
rollback or automatic retry. Read again before repeating uncertain writes.
Errors: 400 invalid input, 401/403 auth/scope, 409 offline, 501 unsupported,
502 transport/provider. HTTP uses no-store.

iPhone differences: linkedProfiles means Accounts Center visibility, not confirmed
equivalence to Links or Business websites. Advanced call/message/defense controls
are not labelled silence-unknown-callers or protect-IP without evidence. Status
is separate from About: Zapo exposes status.setPrivacy including FB/IG flags,
but no equivalent read in that coordinator. The panel now offers Status audience:
My contacts, My contacts except, and Only share with. No current audience is preselected.
Explicitly choose a mode and the complete list (maximum 100 numbers/JIDs; empty
for contacts), then confirm replacement. PUT uses operation `status`, mode
`CONTACTS`/`DENY_LIST`/`ALLOW_LIST`, and `userJids`. Numbers become PN JIDs, LIDs
are preserved, and duplicates removed. SDK success confirms a write, not a readback.
This affects future statuses, does not publish content or alter existing statuses,
and sends no FB/IG flags. Check the native app before retrying uncertain writes.
The unsupported-features notice was removed from the panel.
Status resharing, Face ID, camera effects, Privacy Checkup, live-location sharing
and locked chats are not changed by this panel.
See [official privacy documentation](https://zapo.to/en/guides/profile-privacy).

## Google Maps configuration

The location preview and edit button share a centered block. With a configured key
and coordinates, address/latitude/longitude inputs appear only while editing the
location, alongside the map. Finishing hides inputs without clearing their values.
Without a key, only manual inputs are shown; Google is not loaded. Map failures
also preserve manual editing.

In Google Cloud, select a project with active billing and enable **Maps JavaScript
API**, **Places API (New)** and **Maps Static API**. Set quotas and budget alerts;
alerts do not automatically cap spending. Create a browser API key restricted to
the panel's actual HTTP referrer origins (including protocol/port), and restrict
it to those three APIs. Save it under **Settings → Google Maps**. Saving confirms
Redis persistence, not Google authorization. Never use an unrestricted server key.

Business profiles with coordinates show a Static Maps image. **Edit location**
opens autocomplete and a draggable marker; **Finish location** returns to the
preview. Without coordinates, the editor opens without inventing a saved location.
Only **Save** updates WhatsApp. **Use my location** asks browser permission on
click and requires HTTPS or a supported localhost context. It changes coordinates,
not the address. Autocomplete selection fills both; no reverse geocoding is used.

Admin endpoints: GET/PUT/DELETE `/admin/settings/google-maps` for status/save/remove;
GET `/admin/settings/google-maps/browser` returns the browser key with no-store.
The key is necessarily visible to the browser. Reload open tabs after replacing it.
Static images load directly from Google and are not persisted to S3/Redis. This
version does not sign Static Maps URLs; projects requiring signed requests are
not supported. The lab uses DEMO_MAP_ID; production needs a dedicated map ID.
If loading fails, check billing, enabled APIs, quotas and referrer restrictions.
Manual address entry remains available. Searches/coordinates are sent to Google.

Official guides: [API setup](https://developers.google.com/maps/documentation/maps-static/get-api-key),
[Places](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new),
[security](https://developers.google.com/maps/api-security-best-practices).

Public profile snapshots are cached per session in Redis for up to 24 hours.
GET returns the cache when available; add `?refresh=1` to read WhatsApp and update
it. The panel renders cached data first, then refreshes once in the background
without overwriting edited fields. Manual reload and post-save reads force a
refresh. `cache` includes source, updated_at, stale and optional refresh_failed.
Failures preserve previous data; partial failures retain affected sections and
report warnings. Confirmed writes fence older in-flight reads off the cache.
No credentials, PIN or image bytes are cached. Redis failure falls back to a live
read; HTTP responses use no-store.

The **Profile** tab follows **Connected devices** for mobile-primary sessions,
or **Overview** for linked sessions. Both use the authenticated session's Zapo
worker. Personal and Business accounts support display name, About, avatar and
username operations. Business accounts also support description, address, email,
up to two websites, coordinates, category IDs, weekly hours and cover upload.

Verified commercial name is read-only. Coverage area, location notes, a category
catalog and cover retrieval are not available in this integration. A display
name is not a verified commercial name. No phone/account-type changes or recovery
PIN are exposed.

Authenticate with `Authorization: Bearer <token>`. Manager users can only access
assigned sessions. GET `/{phone}/profile` reads the current account. PUT
`/{phone}/profile/{field}` accepts `{"value":...}` where field is `name`, `about`,
`username`, `business`, `picture` or `cover`. DELETE is supported for `picture`,
`username` and `cover`; deleting a cover requires `{"value":"COVER_ID"}` returned
by its upload. There is no target JID parameter.

Business updates are deltas: omitted fields remain unchanged, empty strings clear
text, empty arrays clear lists. Coordinates must be supplied together; zero is
valid. Hours use IANA timezones, weekday codes `sun`–`sat` and modes `open_24h`,
`specific_hours`, `appointment_only`. Closed days are omitted. Specific hours use
minutes from midnight, 0–1439, opening before closing; this version supports one
interval per day and no overnight interval.

Images are raw Base64 strings without a data URL prefix, at most 5 MiB decoded and
20 million pixels. Avatars are center-cropped to 640×640 JPEG; covers preserve
aspect ratio at a maximum width of 1600. Remote URLs are not fetched.

Cover uploads require configured S3 storage. Uno retains the normalized JPEG in
S3 without scheduled deletion, and its confirmed ID, object key and timestamp in
Redis without TTL. GET profile includes a local `cover` preview (`id`, `url`,
`updated_at`, `source: "uno_upload"`); its signed URL lasts 15 minutes and is
renewed on every GET. External WhatsApp edits cannot be detected. The panel shows
cover and avatar together, with separate Edit controls and a prefilled removal ID.
Replacement/removal cleans only the previously tracked local object after remote
success. A `warning` on a successful mutation indicates incomplete local storage
or cleanup; keep the returned ID in that case.

A successful write confirms SDK completion, not immediate propagation to every
device. Writes are separate operations, not a transaction across all sections.
Read `warnings` before interpreting null fields as empty data. If a network error
makes a write uncertain, read the profile before retrying. HTTP 400 validates
input, 401/403 rejects access, 409 signals offline/Business-required/username
rejected, 501 unsupported provider, and 502 provider failure.

See [interactive API](/en/api-reference), [Postman](/en/guide/postman) and the
[official Zapo contract](https://zapo.to/en/guides/profile-privacy). Implementation
targets installed SDK 1.9.0. Tests use synthetic accounts/images; real writes in
each account/transport combination still require an authorized acceptance test.

### Invalid image diagnostics

In the panel, **Edit → Upload photo/cover** opens the file picker directly.
Selecting an image starts the upload with progress feedback, without an extra
form or Save button. Cancelling the picker sends nothing. Removal remains in
the Edit menu with confirmation; the per-image limit is 5 MiB.

`400 profile_invalid_image` means local preparation failed before WhatsApp upload.
The worker logs `PROFILE_IMAGE_PREPARATION_FAILED` with `field` (picture or cover),
`inputBytes`, `limitInputPixels` (20 million) and a classified `reason`: pixel limit,
unsupported format, unavailable decoder, corrupt/truncated image, memory failure
or unclassified decoder error. Image bytes, base64, private metadata and raw
decoder text are never logged. Unclassified failures need further investigation;
this diagnostic does not change limits or the HTTP response.
