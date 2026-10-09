import { webcrypto } from 'node:crypto'
import { uploadSessionRestore } from '../../frontend/features/session_restore_upload'

beforeAll(() => { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }) })

test('576 MiB upload uses 72 bounded HTTP parts and polls the asynchronous result without a whole-file buffer', async () => {
  const size = 576 * 1024 * 1024, partSize = 8 * 1024 * 1024
  const file: any = { size, slice: jest.fn((start, end) => new Blob([Buffer.alloc(end - start, 7)])) }
  const api: any = { request: jest.fn(async (path, init) => {
    if (path.endsWith('restore-uploads')) return { id: 'test', partSize, parts: 72 }
    if (init?.method === 'PUT') { expect(init.body.size).toBe(partSize); expect(init.headers['X-Part-SHA256']).toMatch(/^[a-f0-9]{64}$/); return { received: Number(path.split('/').pop()) + 1, parts: 72 } }
    if (path.endsWith('/complete')) return { state: 'restoring' }
    return { state: 'ready', result: { warning: 'synthetic-warning' } }
  }) }
  const callbacks = { created: jest.fn(), progress: jest.fn(), active: () => true }
  expect(await uploadSessionRestore(api, file, 'synthetic-password', callbacks)).toEqual({ warning: 'synthetic-warning' })
  expect(api.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(72)
  expect(file.slice).toHaveBeenCalledTimes(72)
  expect(callbacks.progress).toHaveBeenCalledWith('Upload confirmado: 100% (72/72 partes).')
  expect(callbacks.created).toHaveBeenCalledWith('test')
})

test('failed part cancels temporary upload, but a lost completion response never cancels a possible restoration', async () => {
  for (const failure of ['part', 'complete', 'failed', 'interrupted']) {
    const api: any = { request: jest.fn(async (path, init) => {
      if (path.endsWith('restore-uploads')) return { id: 'test', partSize: 8 * 1024 * 1024, parts: 1 }
      if (init?.method === 'DELETE') return {}
      if (init?.method === 'PUT' && failure === 'part' || path.endsWith('/complete') && failure === 'complete') throw new Error('network lost')
      if (init?.method === 'PUT') return { received: 1, parts: 1 }
      if (!init?.method) return { state: failure, error: 'synthetic-error' }
      return {}
    }) }
    await expect(uploadSessionRestore(api, new Blob(['abc']), 'synthetic-password', { created: jest.fn(), progress: jest.fn(), active: () => true })).rejects.toThrow()
    expect(api.request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(failure === 'part')
  }
})

test('unsafe chunk settings and stale views are rejected before sending file parts', async () => {
  for (const [partSize, active] of [[16 * 1024 * 1024, true], [8 * 1024 * 1024, false]] as const) {
    const api: any = { request: jest.fn(async () => ({ id: 'test', partSize, parts: 1 })) }
    await expect(uploadSessionRestore(api, new Blob(['abc']), 'synthetic-password', { created: jest.fn(), progress: jest.fn(), active: () => active })).rejects.toThrow()
    expect(api.request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  }
})

test('missing part acknowledgement never finalizes the upload', async () => {
  const api: any = { request: jest.fn(async (path, init) => path.endsWith('restore-uploads') ? { id: 'test', partSize: 8 * 1024 * 1024, parts: 1 } : init?.method === 'PUT' ? { received: 0, parts: 1 } : {}) }
  await expect(uploadSessionRestore(api, new Blob(['abc']), 'synthetic-password', { created: jest.fn(), progress: jest.fn(), active: () => true })).rejects.toThrow('não confirmou')
  expect(api.request.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false)
})
