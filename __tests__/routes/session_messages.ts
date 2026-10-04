import express from 'express'
import request from 'supertest'
import { SessionMessagesController } from '../../src/controllers/session_messages_controller'
import { SessionMessages } from '../../src/services/messages/session_messages'
import { SendError } from '../../src/services/send_error'
import { managerAccess } from '../../src/services/manager_access'
import { Readable } from 'node:stream'
import { SessionMessageMedia } from '../../src/services/messages/session_message_media'

jest.mock('../../src/services/meta_alias', () => ({ resolveSessionPhoneByMetaId: jest.fn(async phone => phone) }))
const setup = (principal?: object) => {
  const service = { conversations: jest.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null, indexing: false }), messages: jest.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) }
  const load = jest.fn().mockResolvedValue({ authToken: 'session-key', getStore: jest.fn().mockResolvedValue({ mediaStore: { downloadMediaStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('test media'))) } }) })
  const controller = new SessionMessagesController(service as unknown as SessionMessages, load)
  const app = express()
  if (principal) app.use(managerAccess({ authenticate: jest.fn().mockResolvedValue(principal) } as any, async phone => phone))
  app.get('/v15.0/:phone/conversations', controller.handle.bind(controller))
  app.get('/v15.0/:phone/conversations/:conversationId/messages', controller.handle.bind(controller))
  app.get('/v15.0/:phone/messages/:messageId/media', controller.handle.bind(controller))
  return { app, service }
}
describe('session message HTTP access', () => {
  test('denies unauthenticated history and scoped media', async () => {
    const { app, service } = setup()
    await request(app).get('/v15.0/5511999999999/conversations').expect(403)
    await request(app).get('/v15.0/5511999999999/messages/ABC/media').expect(403)
    expect(service.conversations).not.toHaveBeenCalled()
  })
  test('reads authorized session with explicit cursor and no-store', async () => {
    const { app, service } = setup()
    const response = await request(app).get('/v15.0/5511999999999/conversations?limit=30&search=Ana&kind=direct').set('Authorization', 'Bearer session-key').expect(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(service.conversations).toHaveBeenCalledWith('5511999999999', expect.objectContaining({ search: 'Ana', kind: 'direct', limit: 30 }))
  })
  test('Manager assignment isolates history and media', async () => {
    const { app, service } = setup({ role: 'user', phones: ['5511999999999'] })
    await request(app).get('/v15.0/5511888888888/conversations').set('Authorization', 'Bearer mgr_key_fixture').expect(403)
    await request(app).get('/v15.0/5511888888888/messages/ABC/media').set('Authorization', 'Bearer mgr_key_fixture').expect(403)
    await request(app).get('/v15.0/5511999999999/conversations/123%40lid/messages?ids=ABC,DEF').set('Authorization', 'Bearer mgr_key_fixture').expect(200)
    expect(service.messages).toHaveBeenCalledWith('5511999999999', '123@lid', expect.objectContaining({ ids: ['ABC', 'DEF'] }))
  })
  test('reports domain cursor errors and Redis failures explicitly', async () => {
    const { app, service } = setup()
    service.conversations.mockRejectedValueOnce(new SendError(409, 'message_cursor_expired_reload'))
    expect((await request(app).get('/v15.0/5511999999999/conversations').set('Authorization', 'Bearer session-key').expect(409)).body.error).toBe('message_cursor_expired_reload')
    service.conversations.mockRejectedValueOnce(new Error('secret upstream diagnostic'))
    const result = await request(app).get('/v15.0/5511999999999/conversations').set('Authorization', 'Bearer session-key').expect(503)
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
  test('returns media stream with safe headers after authorization', async () => {
    const spy = jest.spyOn(SessionMessageMedia.prototype, 'load').mockResolvedValue({ file: '5511999999999/ABC.png', mime_type: 'image/png', filename: 'photo.png' })
    try {
      const { app } = setup()
      const result = await request(app).get('/v15.0/5511999999999/messages/ABC/media').set('Authorization', 'Bearer session-key').expect(200)
      expect(result.headers['x-content-type-options']).toBe('nosniff'); expect(result.headers['content-disposition']).toMatch(/^attachment/)
      expect(spy).toHaveBeenCalledWith('5511999999999', 'ABC')
    } finally { spy.mockRestore() }
  })
})
