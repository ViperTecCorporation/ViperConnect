import { installSessionMessageSocket } from '../../src/services/messages/session_message_socket'
import { authorizedSessionMessages, SessionMessages } from '../../src/services/messages/session_messages'

jest.mock('../../src/services/messages/session_messages', () => ({ authorizedSessionMessages: jest.fn(), SessionMessages: jest.fn() }))
const setup = () => {
  const connections: Function[] = []; const handlers: Record<string, Function> = {}; const subscriberHandlers: Record<string, Function> = {}
  const subscriber = { on: jest.fn((event, handler) => { subscriberHandlers[event] = handler }), subscribe: jest.fn().mockResolvedValue(undefined), disconnect: jest.fn() }
  const io: any = { on: jest.fn((event, handler) => { if (event === 'connection') connections.push(handler) }), engine: { on: jest.fn() } }
  const socket: any = { connected: true, on: jest.fn((event, handler) => { handlers[event] = handler }), emit: jest.fn() }
  jest.mocked(authorizedSessionMessages).mockResolvedValue(true)
  jest.mocked(SessionMessages).mockImplementation(() => ({ index: jest.fn().mockResolvedValue({ redis: { duplicate: () => subscriber } }) }) as any)
  installSessionMessageSocket(io, jest.fn()); connections[0](socket)
  return { io, socket, subscriber, handlers, subscriberHandlers }
}
describe('session message socket authorization', () => {
  test('installs once and only accepts authorized subscription', async () => {
    const { io, handlers, subscriber, subscriberHandlers, socket } = setup()
    installSessionMessageSocket(io, jest.fn())
    expect(io.on).toHaveBeenCalledTimes(1)
    const ack = jest.fn()
    await handlers['messages:subscribe']({ phone: '5511999999999', token: 'secret' }, ack)
    expect(ack).toHaveBeenCalledWith({ subscribed: true }); expect(subscriber.subscribe).toHaveBeenCalledTimes(1)
    await subscriberHandlers.message('channel', JSON.stringify({ phone: '5511888888888', conversation_id: '123@lid', id: 'other-session' }))
    expect(socket.emit).not.toHaveBeenCalled()
    await subscriberHandlers.message('channel', JSON.stringify({ phone: '5511999999999', conversation_id: '123@lid', id: 'same-session' }))
    expect(socket.emit).toHaveBeenCalledWith('messages:changed', expect.objectContaining({ id: 'same-session' }))
  })
  test('denies missing/revoked credentials and never broadcasts to all sockets', async () => {
    const { handlers, io, subscriber } = setup()
    jest.mocked(authorizedSessionMessages).mockResolvedValue(false)
    const ack = jest.fn()
    await handlers['messages:subscribe']({ phone: '5511999999999', token: 'revoked' }, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
    expect(subscriber.subscribe).not.toHaveBeenCalled()
    expect(io.emit).toBeUndefined()
  })
  test.each(['messages:unsubscribe', 'disconnect'])('stops sensitive updates after %s', async event => {
    const { handlers, subscriberHandlers, socket } = setup()
    await handlers['messages:subscribe']({ phone: '5511999999999', token: 'secret' }, jest.fn())
    handlers[event]()
    await subscriberHandlers.message('channel', JSON.stringify({ phone: '5511999999999', conversation_id: '123@lid' }))
    expect(socket.emit).not.toHaveBeenCalled()
  })
  test('revalidates access before every event', async () => {
    const { handlers, subscriberHandlers, socket } = setup()
    await handlers['messages:subscribe']({ phone: '5511999999999', token: 'secret' }, jest.fn())
    jest.mocked(authorizedSessionMessages).mockResolvedValue(false)
    await subscriberHandlers.message('channel', JSON.stringify({ phone: '5511999999999', conversation_id: '123@lid' }))
    expect(socket.emit).toHaveBeenCalledWith('messages:error', { error: 'session_messages_forbidden' })
    expect(socket.emit).not.toHaveBeenCalledWith('messages:changed', expect.anything())
  })
  test('unsubscribe during slow authentication cannot rejoin', async () => {
    const { handlers } = setup()
    let resolve!: (value: boolean) => void
    jest.mocked(authorizedSessionMessages).mockReturnValue(new Promise(done => { resolve = done }))
    const ack = jest.fn(); const pending = handlers['messages:subscribe']({ phone: '5511999999999', token: 'secret' }, ack)
    handlers['messages:unsubscribe'](); resolve(true); await pending
    expect(ack).not.toHaveBeenCalled()
  })
  test('pubsub events cannot leak unprojected fields or worker error details', async () => {
    const { handlers, subscriberHandlers, socket } = setup()
    await handlers['messages:subscribe']({ phone: '5511999999999', token: 'secret' }, jest.fn())
    await subscriberHandlers.message('channel', JSON.stringify({ phone: '5511999999999', conversation_id: '', secret: 'private', outgoing: { id: 'ABC', status: 'failed', error: 'sensitive stack', token: 'secret' } }))
    const payload = socket.emit.mock.calls.find((call: any[]) => call[0] === 'messages:changed')[1]
    expect(payload.outgoing.status).toBe('failed')
    expect(JSON.stringify(payload)).not.toMatch(/private|sensitive stack|token/)
  })
})
