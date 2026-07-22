jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn().mockResolvedValue(undefined) }))

import { amqpPublish } from '../../src/amqp'
import { defaultConfig } from '../../src/services/config'
import { ReloadAmqp } from '../../src/services/reload_amqp'

describe('ReloadAmqp provider switching', () => {
  test('notifies both workers so the old engine disconnects and the new engine starts', async () => {
    const service = new ReloadAmqp(async () => ({ ...defaultConfig, server: 'server_3', provider: 'zapo' }))
    await service.run('5566')
    const queues = (amqpPublish as jest.Mock).mock.calls.map((call) => call[1])
    expect(queues).toEqual(expect.arrayContaining(['unoapi.reload.server_3.baileys', 'unoapi.reload.server_3.zapo']))
  })
})
