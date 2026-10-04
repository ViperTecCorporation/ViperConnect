import { mockDeep } from 'jest-mock-extended'
import { proto, type WaClient } from 'zapo-js'
import { fromBaileysMessageContent } from '../../src/services/transformer'
import { toZapoMessageContent } from '../../src/services/zapo/zapo_message_mapper'

const cases = [
  { latitude: -11.499317, longitude: -54.873917, name: 'Viper Tec', address: 'R. Afonso Pena, 649 - Rotary Club, Cláudia - MT, 78540-000, Brasil' },
  { latitude: -11.499317, longitude: -54.873917 },
  { latitude: 0, longitude: -54.873917, name: 'Cláudia' },
  { latitude: -11.499317, longitude: 0, address: 'São João, Cuiabá' },
  { latitude: 0, longitude: 0, name: '', address: '' },
  { latitude: 0, longitude: 0, name: 'São José — Açúcar', address: 'Rua São João, coração de Cláudia; '.repeat(80) },
]

describe('static location Cloud API contract', () => {
  test.each(cases)('preserves fields, ID and one message through protobuf and webhook (case %#)', async location => {
    const mapped = await toZapoMessageContent(mockDeep<WaClient>(), { type: 'location', location })
    const wire = proto.Message.decode(proto.Message.encode(mapped.content as any).finish())
    const { latitude, longitude, ...optional } = location
    expect(wire.locationMessage).toEqual({ degreesLatitude: latitude, degreesLongitude: longitude, ...optional })
    const input = {
      key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'original-uno-id' },
      message: wire, messageTimestamp: 1790435992,
    }
    const before = JSON.stringify(input)
    const outputs = fromBaileysMessageContent('5511888888888', input)
    expect(outputs[0].entry).toHaveLength(1)
    expect(outputs[0].entry[0].changes).toHaveLength(1)
    const messages = outputs[0].entry[0].changes[0].value.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'original-uno-id', type: 'location', location })
    expect(messages[0].location).toEqual(location)
    expect(JSON.stringify(input)).toBe(before)
  })

  test.each(['locationMessage', 'liveLocationMessage'])('does not change live location mapping: %s', kind => {
    const input = { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'live-id' },
      message: { [kind]: { degreesLatitude: 0, degreesLongitude: -54, name: 'Live', address: 'Not a static address', isLive: true } }, messageTimestamp: 1790435992 }
    const [result] = fromBaileysMessageContent('5511888888888', input)
    expect(result.entry[0].changes[0].value.messages[0]).toMatchObject({ id: 'live-id', type: 'location', location: { latitude: 0, longitude: -54 } })
    expect(result.entry[0].changes[0].value.messages[0].location).toEqual({ latitude: 0, longitude: -54 })
  })
})
