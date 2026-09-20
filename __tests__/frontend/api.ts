import { ApiClient, ApiError } from '../../frontend/core/api'

describe('frontend API client', () => {
  test('reads symbolic codes separately from localized display text', () => {
    expect(new ApiError(409, 'Texto traduzido', { error_code: 'contact_directory_requires_zapo_provider' }).code).toBe('contact_directory_requires_zapo_provider')
    expect(new ApiError(404, 'Texto traduzido', { error: { error_code: 'message_not_found' } }).code).toBe('message_not_found')
    expect(new ApiError(500, 'Erro').code).toBeUndefined()
  })
  test('calls the browser fetch implementation with the global receiver', async () => {
    const fetcher = jest.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ phone: '5566996269251', status: 'online' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('secret')

    await expect(api.sessions()).resolves.toEqual([{ phone: '5566996269251', status: 'online' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('adds paging and search parameters to contact and group requests', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            contacts: [],
            next_cursor: '0',
            has_more: false,
            total_count: 0,
            raw_total_count: 0,
            ignored_count: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            contacts: [],
            next_cursor: '0',
            has_more: false,
            total_count: 0,
            raw_total_count: 0,
            ignored_count: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            groups: [],
            paging: { cursors: { before: null, after: null } },
          }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)

    await api.contacts('5566', '42', 20, ' Maria ')
    await api.contacts('5566', '0', 20, ' Ma ')
    await api.groups('5566', '20', 20, ' Comercial ')

    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://unoapi.example/5566/contacts?cursor=42&limit=20&search=Maria', expect.any(Object))
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://unoapi.example/5566/contacts?cursor=0&limit=20', expect.any(Object))
    expect(fetcher).toHaveBeenNthCalledWith(3, 'https://unoapi.example/v15.0/5566/groups?cursor=20&limit=20&search=Comercial', expect.any(Object))
  })

  test('loads a profile picture through the authenticated Uno proxy', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } }),
    ) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('admin-token')

    const picture = await api.profilePicture('5566999424178', '53515477086263@lid')

    expect(picture?.type).toBe('image/jpeg')
    expect(fetcher).toHaveBeenCalledWith(
      'https://unoapi.example/v13.0/5566999424178/profile-pictures/53515477086263%40lid',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(new Headers((fetcher as jest.Mock).mock.calls[0][1].headers).get('Authorization')).toBe('Bearer admin-token')
  })

  test('treats a missing profile picture as an empty lazy result', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response(null, { status: 404 })) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)

    await expect(api.profilePicture('5566', '123@lid')).resolves.toBeUndefined()
  })

  test('lists, previews and purges RabbitMQ queues through authenticated backend routes', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ queues: [{ name: 'unoapi.outgoing' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ routing_key: '5566' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: 10 }))) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('admin')

    await expect(api.queues()).resolves.toEqual([{ name: 'unoapi.outgoing' }])
    await expect(api.queueMessages('unoapi.outgoing', '5566')).resolves.toEqual([{ routing_key: '5566' }])
    await expect(api.purgeQueue('unoapi.outgoing', 10)).resolves.toEqual({ removed: 10 })

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://unoapi.example/admin/rabbitmq/queues/unoapi.outgoing/messages?limit=20&session=5566',
      expect.any(Object),
    )
    expect(JSON.parse(`${fetcher.mock.calls[2][1]?.body}`)).toEqual({
      confirm: 'unoapi.outgoing',
      count: 10,
    })
  })

  test('reads and mutates Redis only through backend admin routes', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: ['unoapi:test'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [{ label: 'unoapi', path: 'unoapi:', kind: 'branch' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'unoapi:test', type: 'string', value: 'ok' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ saved: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'string' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: 1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: 3 }))) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('admin')

    await expect(api.redisKeys('test')).resolves.toEqual(['unoapi:test'])
    await expect(api.redisTree()).resolves.toEqual([{ label: 'unoapi', path: 'unoapi:', kind: 'branch' }])
    await expect(api.redisKey('unoapi:test')).resolves.toMatchObject({ type: 'string' })
    await api.saveRedisKey('unoapi:test', 'string', 'value', -1)
    await expect(api.redisQuery('TYPE', ['unoapi:test'])).resolves.toBe('string')
    await expect(api.deleteRedisKey('unoapi:test')).resolves.toEqual({ removed: 1 })
    await expect(api.deleteRedisPrefix('unoapi:zapo:test:')).resolves.toEqual({ removed: 3 })

    expect(JSON.parse(`${fetcher.mock.calls[3][1]?.body}`)).toMatchObject({
      confirm: 'unoapi:test',
      type: 'string',
    })
    expect(JSON.parse(`${fetcher.mock.calls[6][1]?.body}`)).toEqual({
      confirm: 'unoapi:zapo:test:',
    })
  })

  test('loads a VoIP recording as an authenticated blob', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/mpeg' } })) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('admin-token')
    const blob = await api.voipRecording('record-1')
    expect(blob.type).toBe('audio/mpeg')
    expect(fetcher).toHaveBeenCalledWith(
      'https://unoapi.example/admin/voip/recordings/record-1',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    expect(new Headers((fetcher as jest.Mock).mock.calls[0][1].headers).get('Authorization')).toBe('Bearer admin-token')
  })

  test('queries paged VoIP history without losing filters', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [], total: 0, page: 2, pageSize: 50, totalPages: 1,
    }))) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)

    await api.voipHistory({ page: 2, pageSize: 50, search: ' 1001 ', startDate: '2026-08-01', endDate: '2026-08-05' })

    expect(fetcher).toHaveBeenCalledWith(
      'https://unoapi.example/admin/voip/console/history?page=2&pageSize=50&search=1001&startDate=2026-08-01&endDate=2026-08-05',
      expect.any(Object),
    )
  })

  test('uploads transfer audio with an encoded Unicode filename', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploaded: true }))) as unknown as typeof fetch
    const api = new ApiClient('https://unoapi.example', fetcher)
    api.setToken('admin')

    const file = new File([new Uint8Array([1, 2])], 'áudio espera.mp3', { type: 'audio/mpeg' })
    await api.voipUploadTransferAudio('support', file)

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://unoapi.example/admin/voip/console/extensionGroups/support/transfer-audio',
      expect.any(Object),
    )
    const calls = (fetcher as jest.Mock).mock.calls
    const headers = new Headers(calls[0][1]?.headers)
    expect(headers.get('X-File-Name')).toBe(encodeURIComponent('áudio espera.mp3'))
    expect(headers.get('Content-Type')).toBe('audio/mpeg')
  })
})
