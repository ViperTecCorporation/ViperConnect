import { ManagerVoipAccess } from '../../src/services/manager_voip_access'
import { VoipController } from '../../src/controllers/voip_controller'

const phone = '55661111'
const foreign = '55662222'
const state = (): any => ({
  zapoLines: [
    { session: phone, sessionId: 's1', assignmentStatus: 'assigned', automatic: { extensionId: 'ext1', username: phone, basicInboundEnabled: true } },
    { session: foreign, sessionId: 's2', assignmentStatus: 'assigned', automatic: { extensionId: 'ext2', username: foreign } },
  ],
  config: {
    sessions: [
      { id: 's1', unoSession: phone, automaticExtensionId: 'ext1', routing: { extensions: [] } },
      { id: 's2', unoSession: foreign, automaticExtensionId: 'ext2', routing: { extensions: [] } },
    ],
    extensions: [
      { id: 'ext1', username: phone, companyId: 'same', provisioningSource: 'zapo_auto', extensionGroupIds: [], hasPassword: true },
      { id: 'ext2', username: foreign, companyId: 'same', provisioningSource: 'zapo_auto', extensionGroupIds: [] },
      { id: 'manual', username: 'manual', companyId: 'same', provisioningSource: 'manual', extensionGroupIds: [] },
    ],
    extensionGroups: [],
  },
})
const fixture = (snapshot = state()) => {
  const credentials: any = { extensionId: 'ext1', username: phone, password: 'own-secret', sipEndpointMode: 'extension',
    companyId: 'same', token: 'global-secret', webrtc: { credential: 'global-secret' },
    sip: { domain: 'sip.example.test', publicWsUrl: 'wss://sip.example.test/ws', iceServers: [{ credential: 'global-secret' }], password: 'global-secret' } }
  const service = { request: jest.fn(async (path: string, init?: RequestInit): Promise<any> => {
    if (path === '/v1/console/bootstrap') return snapshot
    if (path === '/v1/console/extensions/ext1/credentials') return credentials
    if (path === '/v1/console/extensions/ext1/sip-mode') return { extensionId: 'ext1', sipEndpointMode: JSON.parse(init?.body as string).sipEndpointMode, secret: 'global-secret' }
    throw new Error(`Unexpected path: ${path}`)
  }) }
  return { service, credentials, access: new ManagerVoipAccess(service as any, [phone]) }
}

describe('automatic SIP extension ownership', () => {
  test.each([['extension', 'trunk'], ['trunk', 'extension']])('changes own automatic SIP mode %s -> %s through controller', async (from, to) => {
    const snapshot = state()
    snapshot.config.extensions[0].sipEndpointMode = from
    const { service } = fixture(snapshot)
    const res: any = { locals: { manager: { role: 'user', phones: [phone] } }, setHeader: jest.fn(), json: jest.fn() }
    await new VoipController(service as any).console({ method: 'PUT', params: { 0: 'extensions/ext1/sip-mode' },
      body: { sipEndpointMode: to }, originalUrl: '/admin/voip/console/extensions/ext1/sip-mode?extensionId=ext2' } as any, res)
    expect(service.request).toHaveBeenNthCalledWith(1, '/v1/console/bootstrap')
    expect(service.request).toHaveBeenNthCalledWith(2, '/v1/console/extensions/ext1/sip-mode', {
      method: 'PUT', body: JSON.stringify({ sipEndpointMode: to }),
    })
    expect(res.json).toHaveBeenCalledWith({ extensionId: 'ext1', sipEndpointMode: to })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  test('trunk automatic extension remains listed and its credentials remain accessible', async () => {
    const snapshot = state()
    snapshot.config.extensions[0].sipEndpointMode = 'trunk'
    const { access, credentials } = fixture(snapshot)
    credentials.sipEndpointMode = 'trunk'
    expect(await access.console('extensions', 'GET')).toEqual({ items: [{ id: 'ext1', username: phone, hasPassword: true, sipEndpointMode: 'trunk' }] })
    expect(await access.console('extensions/ext1/credentials', 'GET')).toMatchObject({ password: 'own-secret', sipEndpointMode: 'trunk' })
  })

  test.each([undefined, null, {}, [], 'trunk', { sipEndpointMode: true }, { sipEndpointMode: ['trunk'] },
    { sipEndpointMode: 'TRUNK' }, { sipEndpointMode: ' trunk' }, { sipEndpointMode: null },
    { sipEndpointMode: 'trunk', extensionId: 'ext1' }, { sipEndpointMode: 'extension', session: phone },
    { sipEndpointMode: 'trunk', companyId: 'same' }, { sipEndpointMode: 'trunk', password: 'new' },
  ])('returns input 400 with stable translatable code for invalid body %#', async body => {
    const { service } = fixture()
    const res: any = { locals: { manager: { role: 'user', phones: [phone] } }, setHeader: jest.fn(), json: jest.fn(), status: jest.fn() }
    res.status.mockReturnValue(res)
    await new VoipController(service as any).console({ method: 'PUT', params: { 0: 'extensions/ext1/sip-mode' }, body } as any, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_sip_endpoint_mode' })
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each(['ext2', 'manual', phone, foreign, 'missing'])('rejects mode write via foreign/manual/alias ID %s', async id => {
    const { access, service } = fixture()
    await expect(access.console(`extensions/${id}/sip-mode`, 'PUT', { sipEndpointMode: 'trunk' })).rejects.toMatchObject({ status: 403 })
    expect(service.request).toHaveBeenCalledTimes(1)
  })

  test.each(['GET', 'POST', 'PATCH', 'DELETE'])('denies mode endpoint method %s', async method => {
    const { access, service } = fixture()
    await expect(access.console('extensions/ext1/sip-mode', method, { sipEndpointMode: 'trunk' })).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each(['extensions/%65xt1/sip-mode', 'extensions/../sip-mode', 'extensions/ext1/sip-mode?x=y', 'extensions/ext1/sip-mode/'])('denies noncanonical mode path %s', async path => {
    const { access, service } = fixture()
    await expect(access.console(path, 'PUT', { sipEndpointMode: 'trunk' })).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each([{ extensionId: 'ext2', sipEndpointMode: 'trunk' }, { extensionId: 'ext1', sipEndpointMode: 'extension' }])('denies unexpected upstream mode response %#', async result => {
    const { access, service } = fixture()
    service.request.mockResolvedValueOnce(state()).mockResolvedValueOnce(result)
    await expect(access.console('extensions/ext1/sip-mode', 'PUT', { sipEndpointMode: 'trunk' })).rejects.toMatchObject({ status: 403 })
  })

  test.each([null, { role: 'admin', phones: [] }])('preserves admin/legacy mode passthrough %#', async manager => {
    const { service } = fixture()
    const res: any = { locals: { manager }, setHeader: jest.fn(), json: jest.fn() }
    const body = { sipEndpointMode: 'trunk', arbitraryLegacyField: true }
    await new VoipController(service as any).console({ method: 'PUT', params: { 0: 'extensions/ext1/sip-mode' }, body } as any, res)
    expect(service.request).toHaveBeenCalledTimes(1)
    expect(service.request).toHaveBeenCalledWith('/v1/console/extensions/ext1/sip-mode', { method: 'PUT', body: JSON.stringify(body) })
    expect(res.json).toHaveBeenCalledWith({ extensionId: 'ext1', sipEndpointMode: 'trunk', secret: 'global-secret' })
  })

  test('lists canonical owned lines and automatic extensions without secrets or global config', async () => {
    const snapshot = state()
    snapshot.config.extensions[0].password = 'secret'
    const { access } = fixture(snapshot)
    const lines: any = await access.console('zapo-lines', 'GET')
    expect(lines.lines).toHaveLength(1)
    expect(lines.lines[0].automatic).toEqual({ extensionId: 'ext1', username: phone, basicInboundEnabled: true })
    const extensions: any = await access.console('extensions', 'GET')
    expect(extensions).toEqual({ items: [{ id: 'ext1', username: phone, hasPassword: true }] })
    expect(JSON.stringify({ lines, extensions })).not.toMatch(/secret|55662222|manual|companyId/)
  })

  test('returns only own credentials, exact canonical upstream paths, no-store and no query/body delegation', async () => {
    const { service } = fixture()
    const res: any = { locals: { manager: { id: 'u', role: 'user', phones: [phone] } }, setHeader: jest.fn(), json: jest.fn(), status: jest.fn() }
    res.status.mockReturnValue(res)
    await new VoipController(service as any).console({ method: 'GET', params: { 0: 'extensions/ext1/credentials' },
      originalUrl: '/admin/voip/console/extensions/ext1/credentials?session=foreign', body: { extensionId: 'ext2' } } as any, res)
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({ extensionId: 'ext1', username: phone, password: 'own-secret', sipEndpointMode: 'extension',
      sip: { domain: 'sip.example.test', publicWsUrl: 'wss://sip.example.test/ws' } })
    expect(service.request.mock.calls.map(([path]) => path)).toEqual(['/v1/console/bootstrap', '/v1/console/extensions/ext1/credentials', '/v1/console/bootstrap'])
  })

  test.each(['ext2', 'manual', phone, foreign, 'missing'])('rejects foreign/manual/username/unknown ID %s despite claimed phone', async id => {
    const { access, service } = fixture()
    await expect(access.console(`extensions/${id}/credentials`, 'GET', { session: phone, extensionId: 'ext1', companyId: 'same' })).rejects.toMatchObject({ status: 403 })
    expect(service.request).toHaveBeenCalledTimes(1)
  })

  const invalid: Array<[string, (s: any) => void]> = [
    ['manual provisioning', s => { s.config.extensions[0].provisioningSource = 'manual' }],
    ['invalid mode', s => { s.config.extensions[0].sipEndpointMode = 'invalid' }],
    ['noncanonical session', s => { s.zapoLines[0].session = `+${phone}` }],
    ['claimed username only', s => { s.zapoLines[0].automatic.extensionId = 'ext2' }],
    ['conflicting config session', s => { s.config.sessions[0].unoSession = foreign }],
    ['wrong session ID', s => { s.zapoLines[0].sessionId = 's2' }],
    ['missing inventories', s => { delete s.config.extensionGroups }],
    ['duplicate extension', s => { s.config.extensions.push({ ...s.config.extensions[0] }) }],
    ['duplicate line', s => { s.zapoLines.push({ ...s.zapoLines[0] }) }],
    ['shared automatic line', s => { s.zapoLines[1].automatic.extensionId = 'ext1' }],
    ['shared session', s => { s.config.sessions[1].automaticExtensionId = 'ext1' }],
    ['duplicate session phone', s => { s.config.sessions[1].unoSession = phone }],
    ['duplicate username', s => { s.config.extensions[1].username = phone }],
    ['ID username alias collision', s => { s.config.extensions[1].username = 'ext1' }],
    ['username ID alias collision', s => { s.config.extensions[1].id = phone }],
    ['extension group membership', s => { s.config.extensions[0].extensionGroupIds = ['g'] }],
    ['reverse group membership', s => { s.config.extensionGroups = [{ enabled: false, extensionIds: ['ext1'] }] }],
    ['shared direct route', s => { s.config.sessions[1].routing.extensions = ['ext1'] }],
    ['unknown routing shape', s => { delete s.config.sessions[1].routing }],
  ]
  test.each(invalid)('denies ambiguous/manual/shared mapping: %s', async (_name, mutate) => {
    const snapshot = state()
    mutate(snapshot)
    const { access, service } = fixture(snapshot)
    await expect(access.console('extensions/ext1/credentials', 'GET')).rejects.toMatchObject({ status: 403 })
    expect(service.request).toHaveBeenCalledTimes(1)
    expect(await access.console('extensions', 'GET')).toEqual({ items: [] })
    service.request.mockClear()
    await expect(access.console('extensions/ext1/sip-mode', 'PUT', { sipEndpointMode: 'trunk' })).rejects.toMatchObject({ status: 403 })
    expect(service.request).toHaveBeenCalledTimes(1)
  })

  test.each(['extensions/ext1/registrations/reg1', 'sessions/s1', `zapo-lines/${phone}/assign`, 'extensions/ext1'])('denies mutations %s even on owned resources', async suffix => {
    const { access, service } = fixture()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(access.console(suffix, method, { basicInboundEnabled: true, session: phone })).rejects.toMatchObject({ status: 403 })
    }
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each(['extensions/../credentials', 'extensions/%65xt1/credentials', 'extensions/ext1%2f../credentials', 'extensions/ext1/credentials?session=55661111', 'extensions/ext1/credentials/', '/extensions/ext1/credentials'])('denies noncanonical path %s', async path => {
    const { access, service } = fixture()
    await expect(access.console(path, 'GET')).rejects.toMatchObject({ status: 403 })
    expect(service.request).not.toHaveBeenCalled()
  })

  test.each(['extensionId', 'username', 'sipEndpointMode'])('rejects upstream credential identity mismatch %s', async field => {
    const { access, credentials } = fixture()
    credentials[field] = 'foreign'
    await expect(access.console('extensions/ext1/credentials', 'GET')).rejects.toMatchObject({ status: 403 })
  })

  test('rechecks ownership after credentials fetch and fails closed on reassignment', async () => {
    const { access, service, credentials } = fixture()
    const changed = state()
    changed.zapoLines[0].session = foreign
    service.request.mockResolvedValueOnce(state()).mockResolvedValueOnce(credentials).mockResolvedValueOnce(changed)
    await expect(access.console('extensions/ext1/credentials', 'GET')).rejects.toMatchObject({ status: 403 })
  })

  test.each([null, { role: 'admin', phones: [] }])('leaves admin and legacy credential payload unchanged %#', async manager => {
    const { service, credentials } = fixture()
    const res: any = { locals: { manager }, setHeader: jest.fn(), json: jest.fn() }
    await new VoipController(service as any).console({ method: 'GET', params: { 0: 'extensions/ext1/credentials' } } as any, res)
    expect(res.json).toHaveBeenCalledWith(credentials)
    expect(service.request).toHaveBeenCalledTimes(1)
  })
})
