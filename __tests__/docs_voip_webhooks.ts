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

  test('keeps documented event names and a complete parseable artifact example', () => {
    const contract = read('voip-webhooks-contract')
    for (const event of spec.components.schemas.VoipWebhookEnvelope.properties.event_type.enum) {
      expect(contract).toContain(`\`${event}\``)
    }
    const examples = [...contract.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]))
    expect(examples).toHaveLength(1)
    const event = examples[0]
    expect(event).toMatchObject({ schema_version: 1, event_type: 'call.artifacts.updated' })
    expect(event.call).toMatchObject({ state: 'completed', artifacts: {
      recording: { status: 'available' }, ai: { status: 'completed' },
    } })
    expect(event.call.participants[0].sip_call_id).toBeTruthy()
    expect(event.call.business_phone).toBe(event.call.artifacts.note_target.business_phone)
    for (const term of ['answered_elsewhere', '64000', '16000', '52428800', '256 KiB']) {
      expect(contract).toContain(term)
    }
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
