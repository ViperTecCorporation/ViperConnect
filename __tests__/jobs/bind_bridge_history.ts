jest.mock('../../src/amqp', () => ({ amqpConsume: jest.fn() }))
jest.mock('../../src/jobs/history_consumers', () => ({ startHistoryConsumers: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/services/providers/client_factory', () => ({ getClientProvider: jest.fn() }))
jest.mock('../../src/services/incoming_provider', () => ({ IncomingProvider: jest.fn() }))
jest.mock('../../src/services/outgoing_cloud_api', () => ({ OutgoingCloudApi: jest.fn() }))
jest.mock('../../src/services/listener_zapo', () => ({ ListenerZapo: jest.fn() }))
jest.mock('../../src/services/blacklist', () => ({ addToBlacklistRedis: jest.fn(), isInBlacklistInRedis: jest.fn() }))
import { BindBridgeJob } from '../../src/jobs/bind_bridge'
import { startHistoryConsumers } from '../../src/jobs/history_consumers'
import { getConfigRedis } from '../../src/services/config_redis'
import { amqpConsume } from '../../src/amqp'
import { UNOAPI_SERVER_NAME } from '../../src/defaults'

test('starts history once independently of session bindings and leaves live consumers unchanged', async () => {
  const job = new BindBridgeJob('zapo')
  await job.startHistory()
  expect(startHistoryConsumers).toHaveBeenCalledWith('unoapi.history.server_1.zapo', expect.any(Function), false)
  expect(getConfigRedis).not.toHaveBeenCalled()
  ;(getConfigRedis as jest.Mock).mockResolvedValue({
    provider: 'zapo', server: UNOAPI_SERVER_NAME, notifyFailedMessages: true,
    getStore: async () => ({ sessionStore: { isStatusOnline: async () => true } }),
  })
  for (const routingKey of ['5566999999991', '5566999999992', '5566999999993']) {
    await job.consume(UNOAPI_SERVER_NAME, { routingKey })
  }
  expect(startHistoryConsumers).toHaveBeenCalledTimes(1)
  expect(amqpConsume).toHaveBeenCalledTimes(6)
  for (const call of (amqpConsume as jest.Mock).mock.calls) {
    expect(call[1]).toMatch(/^unoapi\.(listener|incoming)\.server_1\.zapo$/)
    expect(call[4]).toEqual({ notifyFailedMessages: false, priority: 5, prefetch: 1, type: 'direct' })
  }
})
