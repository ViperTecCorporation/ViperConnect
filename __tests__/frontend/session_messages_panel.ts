import { SessionMessagesPanel } from '../../frontend/features/session_messages'
import { ApiError } from '../../frontend/core/api'

const setup = () => {
  const panel: any = Object.create(SessionMessagesPanel.prototype)
  Object.assign(panel, { phone: '5511999999999', revision: 1, selected: '123@lid', draft: 'hello', pending: [], messages: [], conversations: [],
    media: new Map(), drafts: new Map(), changed: new Set(), changedConversations: new Set(), contactResults: [],
    api: { request: jest.fn().mockResolvedValue({ messages: [{ id: 'UNO' }] }) }, paint: jest.fn(), history: jest.fn().mockResolvedValue(undefined),
    socket: { emit: jest.fn(), disconnect: jest.fn() }, node: { innerHTML: 'private history' },
  })
  return panel
}
describe('Messages panel lifecycle and pending sends', () => {
  test('closing unsubscribes and clears session data, drafts and pending requests', () => {
    const panel = setup(); const socket = panel.socket
    panel.messages = [{ text: 'private' }]; panel.drafts.set('123@lid', 'private draft')
    panel.close()
    expect(socket.emit).toHaveBeenCalledWith('messages:unsubscribe'); expect(socket.disconnect).toHaveBeenCalled()
    expect(panel.phone).toBe(''); expect(panel.messages).toEqual([]); expect(panel.drafts.size).toBe(0)
  })
  test.each([401, 403])('revoked HTTP %s removes cached history from the DOM', status => {
    const panel = setup(); const node = panel.node
    panel.fail(new ApiError(status, 'forbidden'))
    expect(node.innerHTML).not.toContain('private history'); expect(panel.phone).toBe('')
  })
  test('socket revocation also clears history', () => {
    const panel = setup(); const node = panel.node
    panel.fail(new Error('session_messages_forbidden'))
    expect(node.innerHTML).toContain('permissões'); expect(panel.phone).toBe('')
  })
  test('HTTP acceptance is queued, never claimed as delivered', async () => {
    const panel = setup()
    await panel.send()
    expect(panel.api.request).toHaveBeenCalledWith('/v15.0/5511999999999/messages', expect.objectContaining({ method: 'POST' }))
    expect(panel.pending[0]).toMatchObject({ id: 'UNO', state: 'queued' }); expect(panel.history).toHaveBeenCalled()
    panel.applyStatus({ id: 'UNO', status: 'failed', error: 'Worker failed' })
    expect(panel.pending[0]).toMatchObject({ state: 'failed', error: 'Worker failed' })
  })
  test('known PN is sent through the normal API while the selected history stays LID', async () => {
    const panel = setup()
    panel.conversations = [{ id: '123@lid', kind: 'direct', phone_number: '5566996269251' }]
    await panel.send()
    expect(JSON.parse(panel.api.request.mock.calls[0][1].body).to).toBe('5566996269251')
    expect(panel.selected).toBe('123@lid')
  })
  test('avatar hydration is bounded, cached and rejects late responses after close', async () => {
    const panel = setup(); panel.pictures = new Map(); panel.pictureAttempts = new Set()
    panel.api.profilePicture = jest.fn().mockResolvedValue(undefined)
    await panel.loadPictures([{ id: '123@lid' }]); await panel.loadPictures([{ id: '123@lid' }])
    expect(panel.api.profilePicture).toHaveBeenCalledTimes(1)
    let resolve!: (value: Blob) => void
    panel.api.profilePicture.mockReturnValue(new Promise(done => { resolve = done }))
    const operation = panel.loadPictures([{ id: '456@lid' }]); panel.close(); resolve(new Blob(['image'], { type: 'image/png' })); await operation
    expect(panel.pictures.size).toBe(0)
  })
  test('quote navigation loads only a bounded around window when the original is not loaded', async () => {
    const panel = setup(); panel.node = { querySelectorAll: () => [] }
    panel.api.request.mockResolvedValue({ data: [{ id: 'original', timestamp_ms: 1 }], next_cursor: 'cursor' })
    await panel.jumpToMessage('original')
    expect(panel.api.request.mock.calls[0][0]).toContain('around=original&limit=50')
    expect(panel.historyCursor).toBe('cursor')
  })
  test('loaded originals scroll smoothly without another Redis/API read', async () => {
    const panel = setup(); const target = { dataset: { messageId: 'original' }, scrollIntoView: jest.fn(), animate: jest.fn() }
    panel.messages = [{ id: 'original' }]; panel.node = { querySelectorAll: () => [target] }
    await panel.jumpToMessage('original')
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(target.animate).toHaveBeenCalled(); expect(panel.api.request).not.toHaveBeenCalled()
    panel.messages = []; panel.api.request.mockRejectedValue(new ApiError(404, 'quoted_message_not_available'))
    await expect(panel.jumpToMessage('missing')).rejects.toThrow('não está mais no histórico')
  })
  test('failed sends require explicit retry and preserve the original text', async () => {
    const panel = setup(); panel.api.request.mockRejectedValueOnce(new Error('offline'))
    await panel.send()
    expect(panel.pending[0]).toMatchObject({ text: 'hello', state: 'failed' }); expect(panel.api.request).toHaveBeenCalledTimes(1)
    await panel.send(panel.pending[0])
    expect(panel.pending).toHaveLength(1); expect(panel.pending[0].state).toBe('queued')
  })
  test('late acceptance after changing session is discarded', async () => {
    const panel = setup(); let resolve!: (value: object) => void
    panel.api.request.mockReturnValue(new Promise(done => { resolve = done }))
    const operation = panel.send(); panel.close(); resolve({ messages: [{ id: 'old-session' }] }); await operation
    expect(panel.pending).toEqual([]); expect(panel.history).not.toHaveBeenCalled()
  })
  test('permission failure during send clears content instead of offering a retry', async () => {
    const panel = setup(); panel.api.request.mockRejectedValue(new ApiError(403, 'forbidden'))
    await panel.send(); expect(panel.pending).toEqual([]); expect(panel.phone).toBe('')
  })
})
