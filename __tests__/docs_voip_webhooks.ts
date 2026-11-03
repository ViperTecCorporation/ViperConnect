import fs from 'node:fs'
import YAML from 'yaml'

const spec = YAML.parse(fs.readFileSync('docs/openapi.yaml', 'utf8'))
const config = fs.readFileSync('docs-site/.vitepress/config.mts', 'utf8')

describe.each(['', 'en/'])('VoIP integration documentation (%s)', (locale) => {
  const read = (name: string) => fs.readFileSync(`docs-site/${locale}guide/${name}.md`, 'utf8')
  const route = `/${locale}guide/`

  test('separates setup, contract and recovery with locale-specific navigation', () => {
    const main = read('voip-webhooks')
    for (const name of ['voip-webhooks', 'voip-webhooks-contract', 'voip-webhooks-recovery']) {
      expect(config).toContain(`link: '${route}${name}'`)
      expect(read(name).match(/^# /gm)).toHaveLength(1)
    }
    expect(main).toContain(`](${route}voip-webhooks-contract)`)
    expect(main).toContain(`](${route}voip-webhooks-recovery)`)
    expect(main).not.toMatch(/^## .*?(?:Release|Atualização de|Implementation and acceptance|Implementação e validação)/gm)
    expect(main).not.toContain('ghcr.io/')
  })

  test('keeps the two authentication directions and exact recovery contract', () => {
    const main = read('voip-webhooks')
    const recovery = read('voip-webhooks-recovery')
    for (const term of ['api_access_token', 'VOIP_SERVICE_TOKEN', 'sourceInstanceId', 'artifactsDelivery']) {
      expect(main).toContain(term)
    }
    for (const term of ['sync=webhook_events', 'history_company_id', 'nextCursor', 'hasMore',
      'source_instance_id', 'Authorization: Bearer', '`410`', '`503`', 'VOIP_TRUSTED_SERVICE_ORIGINS']) {
      expect(recovery).toContain(term)
    }
    expect(recovery).not.toContain('sync=changes&')
  })

  test('keeps documented event names and parseable artifact and native offer examples', () => {
    const contract = read('voip-webhooks-contract')
    for (const event of spec.components.schemas.VoipWebhookEnvelope.properties.event_type.enum) {
      expect(contract).toContain(`\`${event}\``)
    }
    const examples = [...contract.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]))
    expect(examples).toHaveLength(2)
    const events = examples.filter((example) => example.schema_version !== undefined)
    const offers = examples.filter((example) => example.offer !== undefined)
    expect(events).toHaveLength(1)
    expect(offers).toHaveLength(1)
    const event = events[0]
    expect(event).toMatchObject({ schema_version: 1, event_type: 'call.artifacts.updated' })
    expect(event.call).toMatchObject({ state: 'completed', artifacts: {
      recording: { status: 'available' }, ai: { status: 'completed' },
    } })
    expect(event.call.participants[0].sip_call_id).toBeTruthy()
    expect(event.call.business_phone).toBe(event.call.artifacts.note_target.business_phone)
    for (const term of ['answered_elsewhere', '64000', '16000', '52428800', '256 KiB']) {
      expect(contract).toContain(term)
    }
    const participant = offers[0]
    expect(participant).toMatchObject({ extension: '1001', state: 'offered' })
    expect(participant.offer).toMatchObject({ id: participant.id, purpose: 'transfer', source_participant_id: 'source-leg-1010' })
    expect(participant.offer.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Number.isNaN(Date.parse(participant.offer.expires_at))).toBe(false)
  })

  test('documents exact native intent correlation and the bounded transfer offer schema', () => {
    const contract = read('voip-webhooks-contract')
    const participant = spec.components.schemas.VoipWebhookCall.properties.participants.items.properties
    const offer = spec.components.schemas.VoipWebhookNativeOffer
    for (const term of ['client_call_id', 'sip_call_id', 'source_participant_id']) {
      expect(contract).toContain(term)
    }
    expect(participant.client_call_id).toMatchObject({ type: 'string', format: 'uuid' })
    expect(participant.offer.$ref).toBe('#/components/schemas/VoipWebhookNativeOffer')
    expect(offer).toMatchObject({ type: 'object', additionalProperties: false, required: ['id', 'expires_at'] })
    expect(offer.properties.purpose.enum).toEqual(['transfer'])
    expect(offer.properties.id).toMatchObject({ minLength: 1, maxLength: 200 })
    expect(offer.properties.source_participant_id).toMatchObject({ minLength: 1, maxLength: 200 })
  })
  test('documents explicit native wake opt-in without claiming push is automatically ready', () => {
    const guide = read('voip-webhooks')
    for (const term of ['nativeWakeEnabled', 'nativeWakeTimeoutSeconds', '**5', '60**', '**30**', 'REGISTER']) {
      expect(guide).toContain(term)
    }
    expect(spec.components.schemas.VoipViperchatWebhook.properties.nativeWakeEnabled.default).toBe(false)
    expect(spec.components.schemas.VoipViperchatWebhook.properties.nativeWakeTimeoutSeconds).toMatchObject({
      type: 'integer', minimum: 5, maximum: 60, default: 30,
    })
  })
})
