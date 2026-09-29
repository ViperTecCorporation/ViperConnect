jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))

import { amqpPublish } from '../../src/amqp'
import { defaultConfig } from '../../src/services/config'
import { ReloadAmqp } from '../../src/services/reload_amqp'

describe('ReloadAmqp Zapo-only runtime', () => {
  beforeEach(() => jest.clearAllMocks())
  test.each(['zapo', 'baileys', 'forwarder'] as const)('invalidates only the active runtime for %s configs', async provider => {
    const service = new ReloadAmqp(async () => ({ ...defaultConfig, server: 'server_3', provider }))
    await service.run('5566')
    const queues = (amqpPublish as jest.Mock).mock.calls.map((call) => call[1])
    expect(queues).toContain('unoapi.reload.server_3.zapo')
    expect(queues.some(queue => queue.endsWith('.baileys'))).toBe(false)
    expect(queues.filter(queue => queue.endsWith('.zapo'))).toHaveLength(1)
  })
  test('uses the default server when missing', async () => {
    const service = new ReloadAmqp(async () => ({ ...defaultConfig, server: undefined }))
    await service.run('5566')
    expect((amqpPublish as jest.Mock).mock.calls.map(call => call[1])).toContain('unoapi.reload.server_1.zapo')
  })
})
