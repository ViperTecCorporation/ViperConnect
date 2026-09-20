import { RedisAdminController } from '../../src/controllers/redis_admin_controller'

const res = () => {
  const value: any = { status: jest.fn(), json: jest.fn() }
  value.status.mockReturnValue(value)
  return value
}
const req = (overrides: Record<string, unknown> = {}) => ({
  headers: { authorization: 'Bearer admin' },
  query: {},
  params: {},
  body: {},
  ...overrides,
}) as any

describe('Redis admin controller', () => {
  const manager = {
    listKeys: jest.fn(),
    listTree: jest.fn(),
    getKey: jest.fn(),
    saveKey: jest.fn(),
    deleteKey: jest.fn(),
    deletePrefix: jest.fn(),
    query: jest.fn(),
  }

  beforeEach(() => jest.clearAllMocks())

  test.each(['list', 'tree', 'get', 'query', 'save', 'remove', 'removeTree'] as const)('denies non-admin access to %s, including protected records', async operation => {
    const response = res()
    await new RedisAdminController(manager as any, 'admin')[operation](req({ headers: { authorization: 'Bearer mgr_key_user' }, params: { key: 'manager-identity:{v1}:users' } }), response)
    expect(response.status).toHaveBeenCalledWith(403)
    Object.values(manager).forEach(method => expect(method).not.toHaveBeenCalled())
  })

  test('rejects non-admin tokens', async () => {
    const response = res()
    await new RedisAdminController(manager as any, 'admin').list(req({ headers: { authorization: 'Bearer session' } }), response)
    expect(response.status).toHaveBeenCalledWith(403)
  })

  test('lists and reads Redis keys', async () => {
    manager.listKeys.mockResolvedValue(['unoapi:test'])
    manager.getKey.mockResolvedValue({ key: 'unoapi:test', type: 'string' })
    const controller = new RedisAdminController(manager as any, 'admin')
    const listResponse = res()
    await controller.list(req({ query: { search: 'test', limit: '20' } }), listResponse)
    expect(manager.listKeys).toHaveBeenCalledWith('test', 20)
    const getResponse = res()
    await controller.get(req({ params: { key: 'unoapi:test' } }), getResponse)
    expect(getResponse.status).toHaveBeenCalledWith(200)
  })

  test('lists direct Redis tree children by prefix', async () => {
    manager.listTree.mockResolvedValue([
      { label: 'zapo', path: 'unoapi:zapo:', kind: 'branch' },
    ])
    const response = res()
    await new RedisAdminController(manager as any, 'admin').tree(
      req({ query: { prefix: 'unoapi:', limit: '20' } }),
      response,
    )
    expect(manager.listTree).toHaveBeenCalledWith('unoapi:', 20)
    expect(response.json).toHaveBeenCalledWith({
      prefix: 'unoapi:',
      nodes: [{ label: 'zapo', path: 'unoapi:zapo:', kind: 'branch' }],
    })
  })

  test('requires exact confirmation before saving or deleting', async () => {
    const controller = new RedisAdminController(manager as any, 'admin')
    await controller.save(req({ params: { key: 'unoapi:test' }, body: { confirm: 'wrong' } }), res())
    await controller.remove(req({ params: { key: 'unoapi:test' }, body: { confirm: 'wrong' } }), res())
    await controller.removeTree(req({ query: { prefix: 'unoapi:test:' }, body: { confirm: 'wrong' } }), res())
    expect(manager.saveKey).not.toHaveBeenCalled()
    expect(manager.deleteKey).not.toHaveBeenCalled()
    expect(manager.deletePrefix).not.toHaveBeenCalled()
  })

  test('deletes a confirmed Redis subtree', async () => {
    manager.deletePrefix.mockResolvedValue(3)
    const response = res()
    await new RedisAdminController(manager as any, 'admin').removeTree(
      req({
        query: { prefix: 'unoapi:zapo:test:' },
        body: { confirm: 'unoapi:zapo:test:' },
      }),
      response,
    )
    expect(manager.deletePrefix).toHaveBeenCalledWith('unoapi:zapo:test:')
    expect(response.json).toHaveBeenCalledWith({
      prefix: 'unoapi:zapo:test:',
      removed: 3,
    })
  })

  test('runs allowlisted queries through the service', async () => {
    manager.query.mockResolvedValue('string')
    const response = res()
    await new RedisAdminController(manager as any, 'admin').query(
      req({ body: { command: 'TYPE', args: ['unoapi:test'] } }),
      response,
    )
    expect(manager.query).toHaveBeenCalledWith('TYPE', ['unoapi:test'])
    expect(response.json).toHaveBeenCalledWith({ result: 'string' })
  })
})
