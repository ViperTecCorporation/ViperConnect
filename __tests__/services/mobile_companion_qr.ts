import { normalizeCompanionQr } from '../../src/services/mobile_primary/companion_qr'

const key = Buffer.alloc(32, 7).toString('base64')
const qr = `ref,with-comma,${key},${key},${key},1`
test('removes only the linked-devices envelope and preserves the complete payload', () => {
  expect(normalizeCompanionQr(`https://wa.me/settings/linked_devices#${qr}`)).toBe(qr)
})
test.each([qr, '', `https://example.com/#${qr}`, `https://wa.me/other#${qr}`, `https://wa.me/settings/linked_devices?x#${qr}`])('does not rewrite bare or unrecognized input', value => {
  expect(normalizeCompanionQr(value)).toBe(value)
})
