# Connect a session

## Zapo SDK version

The `zapo-js` dependency is pinned to **1.11.0**, including SDK reconnection
and pairing fixes. The custom VoIP plugin in `vendor/zapo-voip` remains
unchanged; this update does not integrate upstream's new VoIP features.
The SDK's forced Signal session rebuild option is not automatically enabled
by the application. See [Recover a contact's encryption](./contacts#recover-contact-encryption)
for the manual per-contact maintenance action.

Register a phone number with the Zapo engine, then request either a QR code or
pairing code. Keep the same connection type until the session is deregistered.

```bash
curl -X POST "https://api.yourdomain.com/v15.0/15551234567/register" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"zapo","connectionType":"qrcode","zapoWebClientProfile":"default","label":"Sales"}'
```

## QR client profile

For a new QR session, `zapoWebClientProfile` accepts `default` (the existing Web
behavior), `wa_personal` (panel label **Personal WhatsApp**, UserAgent `ANDROID`)
or `wa_business` (**WhatsApp Business**, `SMB_IOS`). Personal keeps Android
Tablet and QR marker `e`. Starting with 4.0.37, Business defaults to iPad
(DeviceProps `IPAD`), `SMB_IOS`, WebInfo and QR `e`.
The user validated pairing, messages and media in local dev on 2026-10-14,
without the 401 seen with SMB_ANDROID. This does not guarantee every device
or network. Web version, keys, history and VoIP port 3480 are unchanged;
this is not Mobile Primary. Default/personal are unaffected. Publishing does
not automatically upgrade the VPS.

The profile is stored in Redis and reapplied on login, including deferred
payload construction. Personal/Business require QR, not pairing codes.
Changing a registered profile requires deregistration and a new link.
Do not remove other sessions' credentials.

Use `pairing_code` instead of `qrcode` when the phone must type a generated
code. Connection updates are also delivered through Socket.IO. Wait for the
connected status before sending traffic.

## Safe reconnection

### Temporary Business profile diagnostics

A server administrator can enable diagnostics for **one Business session** with
`zapo_business_diagnostics.json` beside the compiled `zapo_business_diagnostics.js`
module. Set `phone` (digits only) and `expiresAt` (UTC ISO, at most 30 minutes
ahead), then restart the worker. Personal settings remain unchanged, although
the restart briefly reconnects its sessions. Diagnostics are disabled by default;
missing, invalid or expired configuration enables no collection. Remove the
activation file after testing.

`ZAPO_BUSINESS_DIAGNOSTIC` only reports registration/login enums, identity
validation stages and inbound/outbound node types. It excludes QR, bytes, keys,
signatures, tokens, message IDs, recipients and content. Output expires and is
limited to 200 records per instance. Hooks do not bypass cryptographic checks,
resend events or modify the handshake. They depend on the pinned Zapo internals
and require revalidation before library upgrades; real acceptance remains unproven.

- A normal disconnect should reconnect automatically when `autoConnect` is on.
- Deregistration removes the native credentials and requires a new pairing.
- Do not run two owners for the same session.
- Keep Valkey and the session data volume persistent across container updates.
