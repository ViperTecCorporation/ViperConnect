import { ListenerAmqp } from '../../src/services/listener_amqp'
import { amqpPublish } from '../../src/amqp'

jest.mock('../../src/amqp', () => ({ amqpPublish: jest.fn() }))

describe('listener AMQP provider isolation', () => {
  beforeEach(() => jest.clearAllMocks())

  test.each(['baileys', 'zapo'] as const)('publishes %s events only to its provider queue', async provider => {
    const listener = new ListenerAmqp(provider)

    await listener.process('5566', [{ update: true }], 'update')

    expect(amqpPublish).toHaveBeenCalledWith(
      expect.any(String),
      `unoapi.listener.server_1.${provider}`,
      '5566',
      expect.objectContaining({ type: 'update' }),
      expect.any(Object),
    )
  })
})
