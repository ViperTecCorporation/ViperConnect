import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'

assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
assert.equal(process.env.UNOAPI_MOBILE_PRIMARY_LAB, 'true')
assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
const base = 'http://127.0.0.1:9876/manager/mobile-devices'
const headers = { Authorization: `Bearer ${process.env.UNOAPI_AUTH_TOKEN}`, 'Content-Type': 'application/json' }
const req = (suffix, method = 'GET', body) => fetch(base + suffix, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
const payload = { phone: `999${randomInt(100000000, 999999999)}`, name: 'Smoke local descartável', platform: 'android', accountType: 'personal', labConsent: true }
let created
try {
  const caps = await req('/capabilities')
  assert.equal(caps.status, 200)
  assert.equal((await caps.json()).smsRegistration, false)
  const results = await Promise.all([req('', 'POST', payload), req('', 'POST', payload)])
  // Retain every successfully created ID before assertions so cleanup remains possible.
  created = await results.find(response => response.status === 201)?.json()
  assert.deepEqual(results.map(response => response.status).sort(), [201, 409])
  assert.ok(created?.id)
  const listing = await (await req('')).json()
  assert.equal(listing.devices.filter(item => item.phone === payload.phone).length, 1)
  assert.equal((await (await req(`/${created.id}`)).json()).state, 'draft')
  assert.equal((await req(`/${created.id}`, 'DELETE', {})).status, 400)
  assert.equal((await req('', 'POST', { ...payload, phone: '9991234567890', otp: '000000' })).status, 400)
  assert.equal((await fetch(base)).status, 401)
  assert.equal((await req(`/${created.id}/registration`, 'POST', {})).status, 404)
  assert.equal((await req(`/${created.id}/registration`)).status, 503)
  assert.equal((await req(`/${created.id}/registration/request`, 'POST', { confirm: true })).status, 503)
  assert.equal((await req(`/${created.id}/registration/verify`, 'POST', { code: '000000' })).status, 503)
  console.log('OK: capacidades, criação concorrente (201/409), leitura, autorização e confirmação de exclusão.')
} finally {
  if (created?.id) {
    const removed = await req(`/${created.id}`, 'DELETE', { confirm: true })
    assert.equal(removed.status, 204)
    assert.equal((await req(`/${created.id}`)).status, 404)
    console.log('OK: somente o rascunho criado pelo teste foi removido; nenhum SMS/socket foi iniciado.')
  }
}
