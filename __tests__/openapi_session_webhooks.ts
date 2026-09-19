import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { SESSION_LIFECYCLE_EVENTS } from '../src/services/session_webhook_types'

describe('documented session lifecycle contract', () => {
  const spec = yaml.load(fs.readFileSync(path.resolve(__dirname, '../docs/openapi.yaml'), 'utf8')) as any
  test('documents administrator-only history and disabled conflict-aware restoration', () => {
    const list = spec.paths['/admin/webhooks/history/{phone}'].get
    const restore = spec.paths['/admin/webhooks/history/{phone}/restore'].post
    expect(list.responses['403']).toBeDefined()
    expect(restore.responses['409']).toBeDefined()
    expect(restore.requestBody.content['application/json'].schema.properties.replace_existing.default).toBe(false)
    expect(restore.responses['200'].content['application/json'].schema.properties.enabled.enum).toEqual([false])
    expect(spec.components.schemas.WebhookHistorySnapshot.properties.webhooks.items.properties.token).toBeUndefined()
  })
  test('documents every management route and event', () => {
    for (const [route, methods] of Object.entries({
      '/admin/session-webhooks': ['get', 'post'], '/admin/session-webhooks/{id}': ['put', 'delete'], '/admin/session-webhooks/states': ['get'],
    })) for (const method of methods) expect(spec.paths[route][method].responses['403']).toBeDefined()
    expect(spec.components.schemas.SessionLifecycleEventName.enum).toEqual(SESSION_LIFECYCLE_EVENTS)
    expect(spec.components.schemas.SessionLifecycleEvent.required).toEqual(expect.arrayContaining(['schema_version', 'event_id', 'state', 'last_verified_at', 'last_observed_at']))
    expect(spec.components.schemas.SessionWebhookDestination.properties.signing_secret).toBeUndefined()
    expect(spec.components.schemas.SessionWebhookDestinationInput.properties.signing_secret.writeOnly).toBe(true)
  })
  test('blacklist specifies seconds, aliases, removal and enqueue semantics', () => {
    const operation = spec.paths['/{phone}/blacklist/{webhook_id}'].post
    expect(operation.description).toMatch(/LID/)
    expect(operation.description).toMatch(/enfileiramento/)
    expect(operation.requestBody.content['application/json'].schema.properties.ttl.description).toMatch(/Segundos/)
  })
  test('documents optional HMAC with explicit removal and rejects short secrets', () => {
    const schema = spec.components.schemas.SessionWebhookDestinationInput
    expect(schema.required).not.toContain('signing_secret')
    const pattern = new RegExp(schema.properties.signing_secret.pattern)
    expect(pattern.test('')).toBe(true)
    expect(pattern.test('s'.repeat(32))).toBe(true)
    expect(pattern.test('s'.repeat(31))).toBe(false)
    expect(pattern.test('s'.repeat(4097))).toBe(false)
    expect(pattern.test('s'.repeat(32) + '\r\nheader')).toBe(false)
  })
})
