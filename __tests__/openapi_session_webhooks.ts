import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { SESSION_LIFECYCLE_EVENTS } from '../src/services/session_webhook_types'

describe('documented session lifecycle contract', () => {
  const spec = yaml.load(fs.readFileSync(path.resolve(__dirname, '../docs/openapi.yaml'), 'utf8')) as any
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
})
