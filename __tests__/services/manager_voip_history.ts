import { ManagerVoipAccess } from '../../src/services/manager_voip_access'
import { VoipController } from '../../src/controllers/voip_controller'
import { VoipServiceError } from '../../src/services/voip_service'

const phone = '55661111'
const other = '55662222'
const supported = { capabilities: { managerSessionHistoryScope: 1 } }
const history = (): any => ({ scope: { version: 1, phones: [phone] }, items: [{ id: 'inbound:55661111:call', phoneNumber: phone,
  remoteNumber: other, recordingStatus: 'available', recordingKey: 'secret', recordingUrl: 'secret', recordingBucket: 'secret',
  error: 'secret', recordingError: 'secret', token: 'secret', nested: { password: 'secret' } }],
  total: 1, page: 1, pageSize: 20, totalPages: 1 })
const setup = (phones: any = [phone], state: any = supported, payload = history()) => {
  const service = {
    request: jest.fn(async (path: string, _init?: RequestInit): Promise<any> => path === '/v1/console/bootstrap' ? state
      : path.startsWith('/v1/console/history') ? payload : {}),
    stream: jest.fn(async (_path: string, _init?: RequestInit) => new Response(null, { headers: { 'X-Unoapi-Session-Scope-Applied': '1', 'cache-control': 'public, max-age=86400' } })),
  }
  const res: any = { locals: { manager: { role: 'user', phones } }, setHeader: jest.fn(), json: jest.fn(), end: jest.fn(), status: jest.fn() }
  res.status.mockReturnValue(res)
  return { service, res, controller: new VoipController(service as any), access: new ManagerVoipAccess(service as any, phones) }
}

describe('versioned Manager history/recording scope', () => {
  test('forwards only GET query allowlist and trusted principal header, projects history', async () => {
    const { service, controller, res } = setup()
    await controller.console({ method: 'GET', params: { 0: 'history' },
      headers: { 'x-unoapi-session-scope': JSON.stringify([other]) }, body: { phones: [other] },
      query: { page: '1', pageSize: '20', limit: '20', search: 'a & b', startDate: '2026-09-01', endDate: '2026-09-20', phones: other, companyId: 'foreign', scope: 'all' },
      originalUrl: '/admin/voip/console/history?scope=all' } as any, res)
    expect(service.request).toHaveBeenNthCalledWith(2, '/v1/console/history?page=1&pageSize=20&limit=20&search=a+%26+b&startDate=2026-09-01&endDate=2026-09-20', {
      headers: { 'X-Unoapi-Session-Scope': JSON.stringify([phone]) },
    })
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/secret|recordingKey|recordingUrl|recordingBucket|recordingError|token/)
    expect(res.json.mock.calls[0][0].items[0]).toEqual({ id: 'inbound:55661111:call', phoneNumber: phone, remoteNumber: other, recordingStatus: 'available' })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  test.each([undefined, {}, { capabilities: {} }, { capabilities: { managerSessionHistoryScope: '1' } }, { capabilities: { managerSessionHistoryScope: 2 } }])('old/unsupported upstream never gets history or stream %#', async state => {
    const { access, service } = setup([phone], state === undefined ? null : state)
    expect((await access.bootstrap()).capabilities).toMatchObject({ history: false, recordings: false })
    service.request.mockClear()
    await expect(access.console('history', 'GET')).rejects.toMatchObject({ status: 403 })
    await expect(access.recording('inbound:55661111:call')).rejects.toMatchObject({ status: 403 })
    expect(service.request.mock.calls.map(([path]) => path)).toEqual(['/v1/console/bootstrap', '/v1/console/bootstrap'])
    expect(service.stream).not.toHaveBeenCalled()
  })

  test('capabilities track upstream marker fresh, bootstrap never auto-loads history', async () => {
    const { access, service } = setup()
    expect((await access.bootstrap()).capabilities).toMatchObject({ history: true, recordings: true })
    expect(service.request.mock.calls.some(([path]) => path.includes('/history'))).toBe(false)
    service.request.mockResolvedValue({})
    await expect(access.console('history', 'GET')).rejects.toMatchObject({ status: 403 })
  })

  test.each([[], ['+55661111'], ['123'], [55661111], undefined])('empty/invalid scope never calls global lists %#', async phones => {
    const { access, service } = setup(phones === undefined ? null : phones)
    expect(await access.console('history', 'GET', {}, { page: '3', limit: '50' })).toEqual({ items: [], total: 0, page: 3, pageSize: 50, totalPages: 1, scope: { version: 1, phones: [] } })
    await expect(access.recording('record')).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
    expect(service.stream).not.toHaveBeenCalled()
  })

  test('deduplicates/sorts assigned phones and accepts exact set echo', async () => {
    const payload = history()
    payload.scope.phones = [other, phone]
    const { access, service } = setup([other, phone, other], supported, payload)
    await access.console('history', 'GET')
    expect(service.request).toHaveBeenLastCalledWith('/v1/console/history', { headers: { 'X-Unoapi-Session-Scope': JSON.stringify([phone, other]) } })
  })

  test.each([
    (r: any) => { delete r.scope }, (r: any) => { r.scope.version = '1' },
    (r: any) => { r.scope.phones = [] }, (r: any) => { r.scope.phones = [phone, phone] },
    (r: any) => { r.scope.phones = [other] }, (r: any) => { r.items[0].phoneNumber = other },
    (r: any) => { delete r.items[0].phoneNumber }, (r: any) => { r.items[0].phoneNumber = `+${phone}` },
    (r: any) => { r.items = [null] }, (r: any) => { r.items = {} },
    (r: any) => { r.total = '1' }, (r: any) => { r.total = -1 },
    (r: any) => { r.page = 0 }, (r: any) => { r.pageSize = 101 },
    (r: any) => { r.totalPages = 10 }, (r: any) => { r.total = 0 },
  ])('rejects entire response on scope/snapshot/metadata failure %#', async mutate => {
    const payload = history()
    mutate(payload)
    const { access } = setup([phone], supported, payload)
    await expect(access.console('history', 'GET')).rejects.toMatchObject({ status: 403 })
  })

  test.each([{ page: ['1', '2'] }, { search: { phones: [other] } }])('rejects structured query values %#', async query => {
    const { access, service } = setup()
    await expect(access.console('history', 'GET', {}, query)).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each(['POST', 'PUT', 'DELETE', 'PATCH'])('history remains GET only: %s', async method => {
    const { access, service } = setup()
    await expect(access.console('history', method)).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
  })

  test('recording uses exact encoded record ID and trusted scope; no-store overrides upstream cache', async () => {
    const { controller, res, service } = setup()
    await controller.recording({ params: { recordId: 'inbound:55661111:call' }, query: { session: other }, headers: { 'x-unoapi-session-scope': '[]' } } as any, res)
    expect(service.stream).toHaveBeenCalledWith('/v1/console/history-records/inbound%3A55661111%3Acall/recording', { headers: { 'X-Unoapi-Session-Scope': JSON.stringify([phone]) } })
    expect(res.end).toHaveBeenCalled()
    expect(res.setHeader.mock.calls.filter(([name]: [string]) => name.toLowerCase() === 'cache-control').every(([, value]: [string, string]) => value === 'no-store')).toBe(true)
  })

  test.each([null, '0', 'true', '1, 1'])('cancels unread stream before piping when applied marker is %s', async marker => {
    const { controller, res, service } = setup()
    const cancel = jest.fn()
    const headers = new Headers()
    if (marker) headers.set('X-Unoapi-Session-Scope-Applied', marker)
    service.stream.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers }))
    await controller.recording({ params: { recordId: 'record' } } as any, res)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.end).not.toHaveBeenCalled()
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything())
  })

  test('foreign record denial cannot be bypassed by claimed owned call/session', async () => {
    const { controller, res, service } = setup()
    service.stream.mockRejectedValue(new VoipServiceError(403, 'secret upstream details'))
    await controller.recording({ params: { recordId: 'foreign' }, query: { callId: 'own', session: phone } } as any, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manager_voip_forbidden' })
    expect(res.end).not.toHaveBeenCalled()
  })
})
