import { recoverContactCrypto } from '../../frontend/features/contact_crypto'
import { renderContactCards } from '../../frontend/features/entities'
import type { ApiClient } from '../../frontend/core/api'

describe('contact encryption recovery action', () => {
  const contact = { user_id: '123@lid', phone_number: '5511999999999', display_name: 'Maria', last_updated_ms: 1 }
  const request = jest.fn()
  const api = { request } as unknown as ApiClient
  beforeEach(() => { request.mockReset().mockResolvedValue({ success: true, resent: false }) })
  test('renders an accessible labeled action only for LID contacts with a session', () => {
    expect(renderContactCards([contact], '5511888888888')).toContain('data-action="recover-contact-crypto"')
    expect(renderContactCards([contact], '')).not.toContain('data-action="recover-contact-crypto"')
    expect(renderContactCards([{ ...contact, user_id: '123@g.us' }], '5511888888888')).not.toContain('data-action="recover-contact-crypto"')
  })
  test('cancels without any request', async () => {
    const confirm = jest.fn().mockReturnValue(false)
    expect(await recoverContactCrypto(api, '5511888888888', contact, confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Maria'))
    expect(request).not.toHaveBeenCalled()
  })
  test('posts the selected session/LID and explicit confirmation', async () => {
    expect(await recoverContactCrypto(api, '5511888888888', contact, () => true)).toBe(true)
    expect(request).toHaveBeenCalledWith('/5511888888888/contacts/recover-crypto', {
      method: 'POST', body: JSON.stringify({ user_id: '123@lid', confirm: true }),
    })
  })
  test('rejects invalid identity before confirmation', async () => {
    const confirm = jest.fn()
    await expect(recoverContactCrypto(api, '5511888888888', { ...contact, user_id: '123:2@lid' }, confirm)).rejects.toThrow()
    expect(confirm).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  test('rejects unconfirmed result', async () => {
    request.mockResolvedValue({ success: false })
    await expect(recoverContactCrypto(api, '5511888888888', contact, () => true)).rejects.toThrow('não confirmada')
  })
  test('propagates cooldown/offline errors without retrying', async () => {
    request.mockRejectedValue(new Error('429: contact_crypto_recovery_cooldown'))
    await expect(recoverContactCrypto(api, '5511888888888', contact, () => true)).rejects.toThrow('429:')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
