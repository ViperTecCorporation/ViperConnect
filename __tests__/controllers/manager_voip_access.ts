import { VoipController } from '../../src/controllers/voip_controller'
import { ManagerVoipAccess } from '../../src/services/manager_voip_access'

const owned = '55661111'
const other = '55662222'
const response = (manager: unknown = { id: 'u', role: 'user', phones: [owned] }) => {
  const res: any = { locals: { manager } }
  res.status = jest.fn(() => res)
  res.json = jest.fn(value => value)
  res.setHeader = jest.fn()
  res.end = jest.fn()
  return res
}
const serviceFor = (calls: unknown[] = []) => ({
  request: jest.fn(async (path: string, _init?: unknown): Promise<any> => {
    if (path === '/v1/zapo/calls') return { calls }
    return { ok: true, token: 'secret', config: { password: 'secret' } }
  }),
  bootstrap: jest.fn(async () => ({ legacy: true })),
  stream: jest.fn(async () => new Response(null)),
})

describe('Manager scoped VoIP boundary', () => {
  test('calls are filtered by real exact session, never peer or request session', async () => {
    const service = serviceFor([
      { session: owned, callId: 'mine', password: 'secret', nested: { token: 'secret' } },
      { session: other, callId: 'theirs', peerJid: owned },
      { phoneNumber: owned, callId: 'unproven' },
      { session: `+${owned}`, callId: 'noncanonical' },
    ])
    const res = response()
    await new VoipController(service as any).calls({ method: 'GET', query: { session: other } } as any, res)
    expect(res.json).toHaveBeenCalledWith({ calls: [{ session: owned, callId: 'mine' }] })
  })

  test('bootstrap is an allowlist projection, not redaction of global state', async () => {
    const service = serviceFor()
    service.request.mockImplementation(async path => {
      if (path === '/v1/zapo/calls') return { calls: [{ session: owned, callId: 'mine' }, { session: other }] }
      if (path === '/v1/zapo/bridges') return { bridges: [{ session: owned, connected: true, token: 'secret' }, { session: other }] }
      return {
        service: { secret: 'secret' }, router: { locks: ['foreign'] }, history: ['foreign'],
        config: {
          accounts: [{ id: 'a', phoneNumber: owned, password: 'secret', aiSummary: { apiKey: 'secret' } }, { phoneNumber: other }],
          sessions: [{ id: 's', unoSession: owned, token: 'secret' }, { unoSession: other }],
          extensions: [{ password: 'secret' }], trunks: ['secret'],
        },
        zapoLines: [{ session: owned, automatic: { password: 'secret' } }, { session: other }],
      }
    })
    const res = response()
    await new VoipController(service as any).bootstrap({} as any, res)
    const result = res.json.mock.calls[0][0]
    expect(result.accounts).toEqual([{ id: 'a', phoneNumber: owned }])
    expect(result.sessions).toEqual([{ id: 's', unoSession: owned }])
    expect(result.bridges).toEqual([{ session: owned, connected: true }])
    expect(result.zapoLines).toEqual([{ session: owned }])
    expect(JSON.stringify(result)).not.toMatch(/secret|foreign|55662222/)
    expect(result.capabilities).toEqual({ scoped: true, activeCalls: true, callCommands: true, createCalls: false, history: false, recordings: false, configuration: false, lines: true, automaticExtensions: true, extensionCredentials: true, extensionSipMode: true, disconnectRegistration: false, basicInboundSettings: false })
    expect(service.bootstrap).not.toHaveBeenCalled()
    expect(service.request.mock.calls.some(([path]) => /history|recording/.test(path))).toBe(false)
  })

  test.each(['accept', 'reject', 'end', 'mute'])('checks inventory before %s and drops arbitrary input', async command => {
    const service = serviceFor([{ session: owned, callId: 'mine' }])
    const res = response()
    await new VoipController(service as any).command({ params: { callId: 'mine', command }, body: { session: owned, muted: true, extensionId: 'foreign', reason: 'arbitrary' } } as any, res)
    expect(service.request).toHaveBeenNthCalledWith(1, '/v1/zapo/calls')
    expect(service.request).toHaveBeenNthCalledWith(2, `/v1/zapo/calls/mine/${command}`, { method: 'POST', body: JSON.stringify({ session: owned, muted: true }) })
    expect(res.json).toHaveBeenCalledWith({ ok: true })
  })

  test.each([
    [[{ session: other, callId: 'target' }], owned],
    [[{ session: owned, callId: 'target' }], other],
    [[{ session: owned, callId: 'target' }], `+${owned}`],
    [[{ phoneNumber: owned, callId: 'target' }], owned],
    [[{ session: owned, callId: 'target' }, { session: other, callId: 'target' }], owned],
    [[], owned],
  ])('denies forged, unknown and ambiguous call ownership %#', async (calls, session) => {
    const service = serviceFor(calls as unknown[])
    const res = response()
    await new VoipController(service as any).command({ params: { callId: 'target', command: 'end' }, body: { session } } as any, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(service.request).toHaveBeenCalledTimes(1)
  })

  test.each(['history?page=2', 'history', 'history-records/id/recording', 'history/id/recording', 'recording/summary', 'recording/settings', 'recording/accounts/a', 'accounts/a', 'sessions/s', 'trunks', 'router/resolve-outbound', 'users', '../bootstrap', '%62ootstrap', 'bootstrap?x=1', '/bootstrap'])('denies console path %s before any upstream call', async suffix => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const service = serviceFor()
      const res = response()
      await new VoipController(service as any).console({ method, params: { 0: suffix } } as any, res)
      expect(res.status).toHaveBeenCalledWith(403)
      if (suffix === 'history' && method === 'GET') expect(service.request).toHaveBeenCalledWith('/v1/console/bootstrap')
      else expect(service.request).not.toHaveBeenCalled()
    }
  })

  test('recording cannot be authorized by a supplied session or call ID', async () => {
    const service = serviceFor([{ session: owned, callId: 'mine' }])
    const res = response()
    await new VoipController(service as any).recording({ params: { recordId: 'other-record' }, query: { session: owned, callId: 'mine' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(service.stream).not.toHaveBeenCalled()
    expect(service.request).toHaveBeenCalledWith('/v1/console/bootstrap')
  })

  test('denies create, unknown commands and shared transfer audio without upstream effects', async () => {
    const service = serviceFor()
    const controller = new VoipController(service as any)
    for (const action of [
      (res: any) => controller.calls({ method: 'POST', body: { session: owned } } as any, res),
      (res: any) => controller.command({ params: { command: 'reset', callId: 'mine' } } as any, res),
      (res: any) => controller.transferAudio({ params: { extensionGroupId: 'g' } } as any, res),
    ]) {
      const res = response()
      await action(res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(service.request).not.toHaveBeenCalled()
    expect(service.stream).not.toHaveBeenCalled()
  })

  test('permissions are read fresh on each request, and malformed principals fail closed', async () => {
    const service = serviceFor([{ session: owned, callId: 'mine' }])
    const controller = new VoipController(service as any)
    for (const manager of [{ role: 'user', phones: [] }, { role: 'user', phones: '*' }, { role: 'unknown', phones: [owned] }, { role: 'user', phones: [Number(owned)] }]) {
      const res = response(manager)
      await controller.calls({ method: 'GET' } as any, res)
      expect(res.json).toHaveBeenCalledWith({ calls: [] })
    }
    const res = response()
    await controller.calls({ method: 'GET' } as any, res)
    expect(res.json).toHaveBeenCalledWith({ calls: [{ session: owned, callId: 'mine' }] })
  })

  test.each([{ id: 'a', role: 'admin', phones: [] }, null])('preserves admin/legacy global bootstrap, calls, commands, history and recording %#', async manager => {
    const service = serviceFor()
    const controller = new VoipController(service as any)
    const res = response(manager)
    await controller.bootstrap({} as any, res)
    expect(service.bootstrap).toHaveBeenCalledTimes(1)
    await controller.calls({ method: 'POST', body: { session: other } } as any, res)
    expect(service.request).toHaveBeenCalledWith('/v1/zapo/calls', { method: 'POST', body: JSON.stringify({ session: other }) })
    await controller.command({ params: { command: 'end', callId: 'other' }, body: { session: other } } as any, res)
    expect(service.request).toHaveBeenCalledWith('/v1/zapo/calls/other/end', { method: 'POST', body: JSON.stringify({ session: other }) })
    await controller.console({ method: 'GET', params: { 0: 'history' }, originalUrl: '/admin/voip/console/history?page=2' } as any, res)
    expect(service.request).toHaveBeenCalledWith('/v1/console/history?page=2', { method: 'GET', body: undefined })
    await controller.recording({ params: { recordId: 'other' } } as any, res)
    expect(service.stream).toHaveBeenCalledWith('/v1/console/history-records/other/recording')
  })

  test('console bootstrap uses scoped bootstrap and suppresses raw upstream errors', async () => {
    const service = serviceFor()
    service.request.mockRejectedValue(new Error('SIP password=secret'))
    const res = response()
    await new VoipController(service as any).console({ method: 'GET', params: { 0: 'bootstrap' } } as any, res)
    expect(res.json).toHaveBeenCalledWith({ error: 'voip_service_error' })
    expect(ManagerVoipAccess.forPrincipal(service as any, undefined)).toBeUndefined()
  })
})
