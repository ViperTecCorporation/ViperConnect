import { bindPublishRoute } from '../src/amqp'

describe('AMQP publish route', () => {
  test('binds the destination queue before returning the publish routing key', async () => {
    const channel = { bindQueue: jest.fn().mockResolvedValue(undefined) }

    const destination = await bindPublishRoute(
      channel as never,
      'unoapi.brigde',
      'unoapi.incoming.server_1.zapo',
      '5566996269251',
    )

    expect(channel.bindQueue).toHaveBeenCalledWith(
      'unoapi.incoming.server_1.zapo',
      'unoapi.brigde',
      'unoapi.incoming.server_1.zapo.5566996269251',
    )
    expect(destination).toBe('unoapi.incoming.server_1.zapo.5566996269251')
  })
})
