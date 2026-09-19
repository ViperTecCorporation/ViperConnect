import { ViperConnectApp } from '../../frontend/app'
import { redisTreeFromKeys, renderRedisPage } from '../../frontend/pages/redis'

const setup = (query = '', session = '') => {
  const app = Object.create(ViperConnectApp.prototype) as any
  app.redisQuery = query
  app.redisSession = session
  app.redisExpandedPrefixes = new Set<string>()
  app.redisSearchCollapsedPrefixes = new Set<string>()
  app.redisTree = redisTreeFromKeys(['unoapi:contacts:5511'])
  app.api = { redisTree: jest.fn() }
  app.render = jest.fn(() => {
    app.html = renderRedisPage({ keys: ['unoapi:contacts:5511'], tree: app.redisTree,
      expandedPrefixes: [...app.redisExpandedPrefixes], searchCollapsedPrefixes: [...app.redisSearchCollapsedPrefixes],
      query: app.redisQuery, sessionFilter: app.redisSession, sessions: [], loading: false, refreshIn: 30, error: '' })
  })
  return app
}

describe('Redis tree navigation', () => {
  test.each([['contacts', ''], ['', '5511']])('collapses and expands filtered results immediately (%s / %s)', async (query, session) => {
    const app = setup(query, session)
    app.render()
    expect(app.html).toContain('data-key="unoapi:contacts:5511"')
    await app.toggleRedisNode('unoapi:')
    expect(app.html).toContain('aria-expanded="false"')
    expect(app.html).not.toContain('data-key="unoapi:contacts:5511"')
    app.render() // Background refresh must not reopen the branch.
    expect(app.html).not.toContain('data-key="unoapi:contacts:5511"')
    await app.toggleRedisNode('unoapi:')
    expect(app.html).toContain('data-key="unoapi:contacts:5511"')
    expect(app.api.redisTree).not.toHaveBeenCalled()
  })
  test('preserves cached tree expansion and collapse without filters', async () => {
    const app = setup()
    await app.toggleRedisNode('unoapi:')
    await app.toggleRedisNode('unoapi:contacts:')
    expect(app.html).toContain('data-key="unoapi:contacts:5511"')
    await app.toggleRedisNode('unoapi:')
    expect(app.html).not.toContain('data-key="unoapi:contacts:5511"')
    expect(app.redisExpandedPrefixes.size).toBe(0)
    expect(app.api.redisTree).not.toHaveBeenCalled()
  })
})
