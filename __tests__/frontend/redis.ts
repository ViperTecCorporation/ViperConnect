import { setLocale } from '../../frontend/core/i18n'
import { mergeRedisTreeLevel, redisParentPrefix } from '../../frontend/domain/redis_tree'
import {
  redisTreeFromKeys,
  redisValueIsRedacted,
  renderRedisDeleteModal,
  renderRedisEditorModal,
  renderRedisPage,
} from '../../frontend/pages/redis'

describe('Redis admin page', () => {
  test.each(['manager-identity:{v1}:users', 'unoapi-webhook-history:5511'])('renders %s as read-only without delete controls', key => {
    const html = renderRedisPage({ keys: [key], tree: {}, expandedPrefixes: [], sessions: [], sessionFilter: '', query: '', selected: { key, type: 'hash', ttl: -1, size: 1, truncated: false, value: { name: 'Operador' }, readOnly: true }, loading: false, refreshIn: 30, error: '' })
    expect(html).toContain('Somente leitura')
    expect(html).toContain('Operador')
    expect(html).not.toContain('data-action="edit-redis-key"')
    expect(html).not.toContain('data-action="delete-redis-key"')
    expect(html).not.toContain('data-action="delete-redis-prefix"')
  })
  afterEach(() => setLocale('pt-BR'))

  test('detects sensitive masked values before enabling edit', () => {
    expect(redisValueIsRedacted({ auth: { token: '[REDACTED]' } })).toBe(true)
    expect(redisValueIsRedacted({ phone: '5566' })).toBe(false)
  })

  test('creates one nested tree node for every colon-separated segment', () => {
    const tree = redisTreeFromKeys(['unoapi:zapo:contacts:5566'])
    expect(tree['']).toEqual([{ label: 'unoapi', path: 'unoapi:', kind: 'branch', descendantCount: 1 }])
    expect(tree['unoapi:']).toEqual([{ label: 'zapo', path: 'unoapi:zapo:', kind: 'branch', descendantCount: 1 }])
    expect(tree['unoapi:zapo:']).toEqual([{ label: 'contacts', path: 'unoapi:zapo:contacts:', kind: 'branch', descendantCount: 1 }])
    expect(tree['unoapi:zapo:contacts:']).toEqual([{ label: '5566', path: 'unoapi:zapo:contacts:5566', kind: 'key' }])
    expect(redisParentPrefix('unoapi-auth:5548991710539:')).toBe('unoapi-auth:')
    expect(redisParentPrefix('unoapi-auth:')).toBe('')
    expect(mergeRedisTreeLevel(
      [{ label: 'unoapi-auth', path: 'unoapi-auth:', kind: 'branch' }],
      [{ label: 'unoapi', path: 'unoapi:', kind: 'branch' }],
      new Set(['unoapi-auth:']),
    )).toEqual([
      { label: 'unoapi', path: 'unoapi:', kind: 'branch' },
      { label: 'unoapi-auth', path: 'unoapi-auth:', kind: 'branch' },
    ])
  })

  test('renders tree, session filter, content and safe query controls', () => {
    const html = renderRedisPage({
      keys: ['unoapi:zapo:contacts:5566', 'unoapi-config:5566'],
      tree: {},
      expandedPrefixes: [],
      sessions: [{ phone: '5566', label: 'Comercial' }],
      sessionFilter: '5566',
      query: '',
      selected: {
        key: 'unoapi-config:5566',
        type: 'string',
        ttl: 60,
        size: 12,
        truncated: false,
        value: { phone: '5566' },
      },
      loading: false,
      refreshIn: 30,
      error: '',
    })
    expect(html).toContain('Árvore de chaves')
    expect(html).toContain('data-filter="redis-session"')
    expect(html).toContain('data-action="select-redis-key"')
    expect(html).toContain('Somente comandos de leitura permitidos')
    expect(html).toContain('<option>SCAN</option>')
  })

  test('renders confirmed edit and delete forms', () => {
    const details = { key: 'unoapi:test', type: 'string' as const, ttl: -1, size: 2, truncated: false, value: 'ok' }
    const editor = renderRedisEditorModal(details)
    expect(editor).toContain('data-form="redis-save"')
    expect(editor).toContain('name="confirm"')
    expect(editor.indexOf('-1 mantém a chave sem expiração.')).toBeLessThan(editor.indexOf('name="ttlSeconds"'))
    expect(renderRedisDeleteModal(details.key)).toContain('data-form="redis-delete"')
    expect(renderRedisDeleteModal('unoapi:zapo:auth:', true)).toContain('data-form="redis-delete-prefix"')
  })

  test('renders explicit expansion arrows and allows selected parents to collapse', () => {
    const base = {
      keys: [],
      tree: redisTreeFromKeys(['unoapi:zapo:contacts:5566']),
      expandedPrefixes: [],
      sessions: [],
      sessionFilter: '',
      query: '',
      loading: false,
      refreshIn: 30,
      error: '',
    }
    expect(renderRedisPage(base)).toContain('data-action="toggle-redis-node"')
    expect(renderRedisPage(base)).toContain('aria-expanded="false"')
    expect(renderRedisPage({
      ...base,
      selected: {
        key: 'unoapi:zapo:contacts:5566',
        type: 'hash' as const,
        ttl: -1,
        size: 1,
        truncated: false,
        value: { name: 'Contato' },
      },
    })).toContain('aria-expanded="false"')
    const expanded = renderRedisPage({
      ...base,
      expandedPrefixes: ['unoapi:'],
    })
    expect(expanded).toContain('aria-expanded="true"')
    expect(renderRedisPage(base)).toContain('data-action="delete-redis-prefix"')
    expect(renderRedisPage(base)).toContain('redis-tree__count')
    expect(expanded).toContain('data-action="delete-redis-prefix"')
    expect(expanded).toContain('btn--ghost redis-tree__delete')
  })

  test('renders Redis maintenance in English', () => {
    setLocale('en')
    expect(renderRedisDeleteModal('unoapi:test')).toContain('Delete Redis key')
  })
})
