import { recordSessionMessageEvent } from '../../src/services/messages/session_message_events'
import { recordSessionWebhookStatuses } from '../../src/services/messages/session_message_status'
import { sessionMessageIndex } from '../../src/services/messages/session_message_index'
import { zapoStoreRegistry } from '../../src/services/zapo/zapo_store_registry'

jest.mock('../../src/services/messages/session_message_index', () => ({ ...jest.requireActual('../../src/services/messages/session_message_index'), sessionMessageIndex: jest.fn() }))
jest.mock('../../src/services/zapo/zapo_store', () => ({ resolveZapoRedisKeyPrefix: () => 'test:' }))
jest.mock('../../src/services/zapo/zapo_store_registry', () => ({ zapoStoreRegistry: { get: jest.fn() } }))
const setup = () => {
  const pipe: any = { eval: jest.fn().mockReturnThis(), get: jest.fn().mockReturnThis(), publish: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([[null, 1], [null, 'provider'], [null, 1]]) }
  const index: any = { state: jest.fn().mockResolvedValue(undefined), key: (_phone: string, part: string) => part, ttl: 1000, redis: { pipeline: () => pipe } }
  jest.mocked(sessionMessageIndex).mockReturnValue(index)
  return { index, pipe }
}
describe('passive message event/status hooks', () => {
  beforeEach(() => jest.clearAllMocks())
  test('receipts and bounded edits update only existing stored message overlays', async () => {
    const { index } = setup()
    await recordSessionMessageEvent('5511999999999', { messageIds: ['ABC'], status: 'read' }, 'receipt')
    expect(index.state).toHaveBeenCalledWith('5511999999999', ['ABC'], { status: 'read' })
    await recordSessionMessageEvent('5511999999999', { targetMessageId: 'ABC', decrypted: { kind: 'message_edit', message: { imageMessage: { caption: 'x'.repeat(17000) } } } }, 'addon')
    expect(index.state.mock.calls[1][2].text).toHaveLength(16000)
  })
  test('unrecognized receipts and events do not mutate state; hook failure is contained', async () => {
    const { index } = setup()
    await recordSessionMessageEvent('5511999999999', { messageIds: ['ABC'], status: 'unknown' }, 'receipt')
    await recordSessionMessageEvent('5511999999999', { decrypted: { kind: 'reaction' } }, 'addon')
    expect(index.state).not.toHaveBeenCalled()
    index.state.mockRejectedValue(new Error('offline'))
    await expect(recordSessionMessageEvent('5511999999999', { messageIds: ['ABC'], status: 'read' }, 'receipt')).resolves.toBeUndefined()
    jest.mocked(sessionMessageIndex).mockReturnValue(undefined)
    await expect(recordSessionMessageEvent('5511999999999', {}, 'addon')).resolves.toBeUndefined()
  })
  test('outgoing status maps provider ID, redacts errors and preserves monotonic status', async () => {
    const { index, pipe } = setup()
    await recordSessionWebhookStatuses('5511999999999', { entry: [{ changes: [{ value: { statuses: [{ id: 'UNO', status: 'failed', errors: ['private stack'] }, { id: '../bad', status: 'read' }] } }] }] }, { provider: 'zapo', useRedis: true } as any)
    expect(pipe.eval).toHaveBeenCalledTimes(1)
    expect(pipe.eval.mock.calls[0][0]).toContain('rank[s.status]')
    expect(index.state).toHaveBeenCalledWith('5511999999999', ['provider'], { status: 'failed' })
    expect(JSON.stringify(pipe.publish.mock.calls)).not.toContain('private stack')
  })
  test('does not initialize Redis for other providers or payloads without statuses', async () => {
    setup()
    await recordSessionWebhookStatuses('5511999999999', {}, { provider: 'zapo', useRedis: true } as any)
    await recordSessionWebhookStatuses('5511999999999', {}, { provider: 'baileys', useRedis: true } as any)
    expect(zapoStoreRegistry.get).not.toHaveBeenCalled()
  })
})
