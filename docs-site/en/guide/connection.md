# Connect a session

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
or `wa_business` (**WhatsApp Business**, `SMB_ANDROID`). Both Android profiles
also advertise `android tablet` DeviceProps and QR platform `e`.

The selection is stored with the session configuration in Redis and reapplied
on login. It remains an experimental Web transport profile, not Mobile Primary.
Android profiles require QR pairing and cannot use a pairing code. Once the
session is registered, changing the profile requires deregistration and a new
link. The override is scoped to the session's asynchronous connection context,
so `default` sessions in the same worker keep the original payload.

Use `pairing_code` instead of `qrcode` when the phone must type a generated
code. Connection updates are also delivered through Socket.IO. Wait for the
connected status before sending traffic.

## Safe reconnection

- A normal disconnect should reconnect automatically when `autoConnect` is on.
- Deregistration removes the native credentials and requires a new pairing.
- Do not run two owners for the same session.
- Keep Valkey and the session data volume persistent across container updates.
