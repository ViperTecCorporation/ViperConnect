import {
  normalizeRabbitMessage,
  rabbitManagementOptions,
  rabbitMessageMatchesSession,
  RabbitManagement,
  RabbitManagementError,
} from '../../src/services/rabbitmq_management'

const options = {
  baseUrl: 'http://rabbitmq:15672',
  username: 'user',
  password: 'secret',
  vhost: '/',
  queuePrefix: 'unoapi',
}

describe('RabbitMQ management service', () => {
  test('lists the two VoIP webhook queues, allows read-only inspection and rejects purging them or accessing other foreign queues', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify([
      { name: 'viperconnect.voip.webhooks.outgoing', messages: 2 },
      { name: 'viperconnect.voip.webhooks.dead', messages: 1 },
      { name: 'viperconnect.private', messages: 99 },
    ]))) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)
    expect((await manager.listQueues()).map(queue => queue.name)).toEqual(['viperconnect.voip.webhooks.outgoing', 'viperconnect.voip.webhooks.dead'])
    await expect(manager.purgeQueue('viperconnect.voip.webhooks.dead')).rejects.toMatchObject({ status: 403 })
    await expect(manager.previewMessages('viperconnect.private')).rejects.toMatchObject({ status: 403 })
  })
  test('derives management credentials and vhost from AMQP_URL', () => {
    expect(rabbitManagementOptions('amqp://user:p%40ss@rabbitmq:5672/viper')).toMatchObject({
      baseUrl: 'http://rabbitmq:15672',
      username: 'user',
      password: 'p@ss',
      vhost: 'viper',
    })
  })

  test('normalizes payloads and redacts credentials', () => {
    expect(normalizeRabbitMessage({
      payload: JSON.stringify({ body: 'oi', authToken: 'secret' }),
      payload_encoding: 'string',
      routing_key: 'unoapi.incoming.5566',
      properties: { headers: { authorization: 'Bearer secret' } },
    })).toMatchObject({
      routing_key: 'unoapi.incoming.5566',
      payload: { body: 'oi', authToken: '[REDACTED]' },
      properties: { headers: { authorization: '[REDACTED]' } },
    })
  })

  test('matches a session by routing key or payload', () => {
    const message = normalizeRabbitMessage({ routing_key: 'unoapi.incoming.5566', payload: '{"phone":"5577"}' })
    expect(rabbitMessageMatchesSession(message, '5566')).toBe(true)
    expect(rabbitMessageMatchesSession(message, '5577')).toBe(true)
    expect(rabbitMessageMatchesSession(message, '5588')).toBe(false)
  })

  test('lists only UnoAPI queues ordered by backlog', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify([
      { name: 'other.queue', messages: 99 },
      { name: 'unoapi.outgoing', messages: 2, messages_ready: 2, consumers: 1 },
      { name: 'unoapi.media.delayed', messages: 10, messages_ready: 10, consumers: 0 },
    ]))) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await expect(manager.listQueues()).resolves.toEqual([
      expect.objectContaining({ name: 'unoapi.media.delayed', messages: 10 }),
      expect.objectContaining({ name: 'unoapi.outgoing', messages: 2 }),
    ])
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toMatch(/^Basic /)
  })

  test('previews with requeue and filters by session', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify([
      { routing_key: 'unoapi.outgoing.5566', payload: '{"phone":"5566"}' },
      { routing_key: 'unoapi.outgoing.5577', payload: '{"phone":"5577"}' },
    ]))) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await expect(manager.previewMessages('unoapi.outgoing', 20, '5566')).resolves.toHaveLength(1)
    expect(JSON.parse(`${fetcher.mock.calls[0][1]?.body}`)).toMatchObject({
      count: 20,
      ackmode: 'ack_requeue_true',
    })
  })

  test('caps an inspection sample at 200 messages', async () => {
    const fetcher = jest.fn(async () => new Response('[]')) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await manager.previewMessages('unoapi.outgoing.dead', 999)

    expect(JSON.parse(`${fetcher.mock.calls[0][1]?.body}`).count).toBe(200)
  })

  test('removes a bounded number of messages without requeue', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify([{}, {}]))) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await expect(manager.removeMessages('unoapi.outgoing.dead', 2)).resolves.toBe(2)
    expect(JSON.parse(`${fetcher.mock.calls[0][1]?.body}`)).toMatchObject({
      count: 2,
      ackmode: 'ack_requeue_false',
    })
  })

  test('purges ready messages and rejects queues outside the UnoAPI prefix', async () => {
    const fetcher = jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await expect(manager.purgeQueue('unoapi.outgoing.dead')).resolves.toBeUndefined()
    await expect(manager.purgeQueue('foreign.queue')).rejects.toEqual(
      expect.objectContaining<RabbitManagementError>({ status: 403, message: 'rabbit_queue_not_allowed' }),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('deletes an allowed queue using the management API', async () => {
    const fetcher = jest.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    const manager = new RabbitManagement(options, fetcher)

    await manager.deleteQueue('unoapi.listener.server_1.baileys.dead')

    expect(fetcher.mock.calls[0][0]).toBe(
      'http://rabbitmq:15672/api/queues/%2F/unoapi.listener.server_1.baileys.dead',
    )
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE')
  })
})
