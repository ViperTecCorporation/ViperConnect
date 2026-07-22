import { shouldNotifyFailureByWhatsApp } from '../../src/services/providers/failure_notification'

describe('provider failure notification policy', () => {
  test('never sends operational failures through a Zapo WhatsApp session', () => {
    expect(shouldNotifyFailureByWhatsApp('zapo', true)).toBe(false)
  })

  test('preserves the configured Baileys behavior', () => {
    expect(shouldNotifyFailureByWhatsApp('baileys', true)).toBe(true)
    expect(shouldNotifyFailureByWhatsApp('baileys', false)).toBe(false)
  })
})
