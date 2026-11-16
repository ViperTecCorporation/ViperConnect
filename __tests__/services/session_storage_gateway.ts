import { randomUUID } from 'node:crypto'
import { getRedis } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { amqpRpc } from '../../src/amqp'
import { sessionStorageGateway } from '../../src/services/session_storage/runtime'

jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn(), getSessionPhones: jest.fn() }))
jest.mock('../../src/services/config_redis', () => ({ getConfigRedis: jest.fn() }))
jest.mock('../../src/amqp', () => ({ amqpRpc: jest.fn(), amqpConsume: jest.fn() }))

test('task polling reads the shared receipt despite cutover generations and unavailable worker, without owner RPC', async () => {
  const phone = '999123456789', id = randomUUID(), task = { id, phone, operation: 'migration', status: 'ready', progress: { phase: 'ready' }, result: { sourcePreserved: false } }
  const get = jest.fn(async (key: string) => key === `unoapi-session-storage:task:${phone}:${id}` ? JSON.stringify(task) : null)
  jest.mocked(getRedis).mockResolvedValue({ get } as any)
  jest.mocked(getConfigRedis).mockRejectedValue(new Error('worker unavailable'))
  jest.mocked(amqpRpc).mockRejectedValue(new Error('generation changed'))
  expect(await sessionStorageGateway.task(phone, id)).toEqual(task)
  expect(getConfigRedis).not.toHaveBeenCalled(); expect(amqpRpc).not.toHaveBeenCalled()
  await expect(sessionStorageGateway.task('999987654321', id)).rejects.toThrow('session_storage_task_not_found')
  await expect(sessionStorageGateway.task(phone, '../foreign')).rejects.toThrow('session_storage_task_invalid')
})

test('public HTTP facade delegates the binary upload to the owner runtime without dropping the stream', async () => {
  const { sessionStorageGateway: facade } = module.require('../../src/services/session_storage/gateway') as typeof import('../../src/services/session_storage/gateway')
  const stream = module.require('node:stream').Readable.from([Buffer.from('test')])
  const delegated = jest.spyOn(sessionStorageGateway, 'restoreUpload').mockResolvedValueOnce({ id: 'synthetic-task' })
  try {
    expect(await facade.restoreUpload!('999123456789', stream, 4)).toEqual({ id: 'synthetic-task' })
    expect(delegated).toHaveBeenCalledWith('999123456789', stream, 4)
  } finally { delegated.mockRestore(); stream.destroy() }
})
