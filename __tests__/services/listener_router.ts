import { mock } from 'jest-mock-extended'
import type { Broadcast } from '../../src/services/broadcast'
import { defaultConfig } from '../../src/services/config'
import type { Listener } from '../../src/services/listener'
import type { Outgoing } from '../../src/services/outgoing'
import { ProviderListener } from '../../src/services/providers/listener_router'

describe('ProviderListener', () => {
  test.each(['baileys', 'zapo'] as const)('routes %s sessions only to their listener', async (provider) => {
    const router = new ProviderListener(mock<Outgoing>(), mock<Broadcast>(), async () => ({ ...defaultConfig, provider }))
    const baileys = mock<Listener>()
    const zapo = mock<Listener>()
    ;(router as any).baileys = baileys
    ;(router as any).zapo = zapo
    await router.process('5511', [{}], 'notify')
    expect(provider === 'zapo' ? zapo.process : baileys.process).toHaveBeenCalledWith('5511', [{}], 'notify')
    expect(provider === 'zapo' ? baileys.process : zapo.process).not.toHaveBeenCalled()
  })
})
