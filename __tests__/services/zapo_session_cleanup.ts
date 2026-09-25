import { mockDeep } from 'jest-mock-extended'
import type { WaStoreSession } from 'zapo-js'
import { clearZapoSession } from '../../src/services/zapo/zapo_session_cleanup'

describe('Zapo session cleanup', () => {
  test('clears signal only after prekey clear has finished recreating its metadata', async () => {
    const session = mockDeep<WaStoreSession>()
    let metadata = false
    session.preKey.clear.mockImplementation(async () => { await Promise.resolve(); metadata = true })
    session.signal.clear.mockImplementation(async () => { expect(metadata).toBe(true); metadata = false })
    await clearZapoSession(session)
    expect(metadata).toBe(false)
  })
  test('clears every persisted domain and its runtime caches', async () => {
    const session = mockDeep<WaStoreSession>()

    await expect(clearZapoSession(session)).resolves.toEqual({ cacheFailures: [] })

    expect(session.auth.clear).toHaveBeenCalledTimes(1)
    expect(session.signal.clear).toHaveBeenCalledTimes(1)
    expect(session.preKey.clear).toHaveBeenCalledTimes(1)
    expect(session.session.clear).toHaveBeenCalledTimes(1)
    expect(session.identity.clear).toHaveBeenCalledTimes(1)
    expect(session.senderKey.clear).toHaveBeenCalledTimes(1)
    expect(session.appState.clear).toHaveBeenCalledTimes(1)
    expect(session.retry.clear).toHaveBeenCalledTimes(1)
    expect(session.groupMetadata.clear).toHaveBeenCalledTimes(1)
    expect(session.chatMetadata.clear).toHaveBeenCalledTimes(1)
    expect(session.deviceList.clear).toHaveBeenCalledTimes(1)
    expect(session.messages.clear).toHaveBeenCalledTimes(1)
    expect(session.messageSecret.clear).toHaveBeenCalledTimes(1)
    expect(session.threads.clear).toHaveBeenCalledTimes(1)
    expect(session.contacts.clear).toHaveBeenCalledTimes(1)
    expect(session.privacyToken.clear).toHaveBeenCalledTimes(1)
    expect(session.destroyCaches).toHaveBeenCalledTimes(1)
  })

  test('tries every domain before reporting a partial cleanup failure', async () => {
    const session = mockDeep<WaStoreSession>()
    session.auth.clear.mockRejectedValue(new Error('redis_down'))

    await expect(clearZapoSession(session)).rejects.toThrow('zapo_session_clear_failed: auth')

    expect(session.privacyToken.clear).toHaveBeenCalledTimes(1)
    expect(session.destroyCaches).toHaveBeenCalledTimes(1)
  })

  test('reports expiring cache failures without blocking deregistration', async () => {
    const session = mockDeep<WaStoreSession>()
    const error = new Error('scan_unavailable')
    session.retry.clear.mockRejectedValue(error)

    await expect(clearZapoSession(session)).resolves.toEqual({
      cacheFailures: [{ domain: 'retry', error }],
    })

    expect(session.auth.clear).toHaveBeenCalledTimes(1)
    expect(session.destroyCaches).toHaveBeenCalledTimes(1)
  })

  test('treats a previously destroyed cache gate as an idempotent cleanup', async () => {
    const session = mockDeep<WaStoreSession>()
    session.retry.clear.mockRejectedValue(new Error('shared-exclusive gate is closed'))
    session.groupMetadata.clear.mockRejectedValue(new Error('shared-exclusive gate is closed'))
    session.chatMetadata.clear.mockRejectedValue(new Error('shared-exclusive gate is closed'))

    await expect(clearZapoSession(session)).resolves.toEqual({ cacheFailures: [] })

    expect(session.auth.clear).toHaveBeenCalledTimes(1)
    expect(session.destroyCaches).toHaveBeenCalledTimes(1)
  })
})
