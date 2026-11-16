jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
import { getRedis } from '../../src/services/redis'
import { publishSqliteMessageChange } from '../../src/services/session_storage/change_events'

test('publishes only scoped invalidation metadata and never raw SQLite contents', async () => {
  const publish = jest.fn().mockResolvedValue(1); (getRedis as jest.Mock).mockResolvedValue({ publish })
  await publishSqliteMessageChange('5566999999999', '12345@lid', 'provider')
  expect(publish).toHaveBeenCalledWith('unoapi:session-messages:changes', JSON.stringify({ phone: '5566999999999', conversation_id: '12345@lid', id: 'provider' }))
})
test('refuses malformed scope before obtaining any Redis connection', async () => {
  ;(getRedis as jest.Mock).mockClear()
  await expect(publishSqliteMessageChange('../foreign', '12345@lid')).rejects.toThrow('invalid_change_event')
  await expect(publishSqliteMessageChange('5566999999999', 'a'.repeat(201))).rejects.toThrow('invalid_change_event')
  expect(getRedis).not.toHaveBeenCalled()
})
