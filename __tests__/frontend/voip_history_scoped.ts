import { ViperConnectApp } from '../../frontend/app'
import { ApiClient } from '../../frontend/core/api'
import { scopedHistoryItems, scopedRecording } from '../../frontend/domain/voip_history'
import { renderScopedVoip } from '../../frontend/pages/voip_scoped'
import type { VoipBootstrap } from '../../frontend/domain/types'

const record = { id: 'r1', phoneNumber: '5511', remoteName: 'Cliente <1>', recordingStatus: 'available', accountLabel: 'SHARED_ACCOUNT', extensionLabel: 'SHARED_EXTENSION' }
const history = { items: [record, { ...record, id: 'foreign', phoneNumber: '5522' }], page: 2, pageSize: 20, total: 40, totalPages: 2, search: 'cliente', startDate: '2026-01-01', endDate: '' }
const state = (): VoipBootstrap => ({ bridges: [], calls: [], history,
  capabilities: { activeCalls: true, callCommands: true, createCalls: false, history: true, recordings: true, configuration: false } })
const setup = () => {
  const app = Object.create(ViperConnectApp.prototype) as any
  Object.assign(app, { identity: { role: 'user' }, sessions: [{ phone: '5511' }], voip: state(), voipRecordingUrls: {},
    render: jest.fn(), showToast: jest.fn(), api: { voipHistory: jest.fn().mockResolvedValue({ ...history, items: [record] }), voipBootstrap: jest.fn().mockResolvedValue(state()), voipRecording: jest.fn().mockResolvedValue(new Blob(['audio'])) } })
  return app
}
const click = (action: string, data: Record<string, string> = {}) => ({ target: {
  closest: (selector: string) => selector === '[data-action]' ? { dataset: { action, ...data } } : null,
  matches: () => false,
} })

describe('scoped call history and recordings', () => {
  test('renders only owned snapshot rows, controls and recordings, never global metadata/settings', () => {
    const html = renderScopedVoip(state(), false, '', {}, ['5511'])
    expect(html).toContain('Chamadas e gravações')
    expect(html).toContain('Cliente &lt;1&gt;')
    expect(html).toContain('data-form="voip-history-filter"')
    expect(html).toContain('data-action="voip-history-page"')
    expect(html).toContain('data-record-id="r1"')
    for (const value of ['foreign', 'SHARED_ACCOUNT', 'SHARED_EXTENSION', 'edit-voip-recording-settings', 'recordingSummary', 'delete-voip']) expect(html).not.toContain(value)
    const unsupported = state()
    unsupported.capabilities!.history = false
    expect(renderScopedVoip(unsupported, false, '', {}, ['5511'])).not.toContain('voip-history-filter')
    unsupported.capabilities!.history = true
    unsupported.capabilities!.recordings = false
    expect(renderScopedVoip(unsupported, false, '', { r1: 'blob:secret' }, ['5511'])).not.toContain('blob:secret')
    expect(renderScopedVoip(unsupported, false, '', {}, ['5511'])).not.toContain('play-voip-recording')
  })

  test('requires known unique owned available record and both capabilities', () => {
    const value = state()
    expect(scopedHistoryItems(value, ['5511'])).toEqual([record])
    expect(scopedRecording(value, ['5511'], 'r1')).toEqual(record)
    expect(scopedRecording(value, ['5511'], 'foreign')).toBeUndefined()
    expect(scopedRecording(value, ['5511'], 'unknown')).toBeUndefined()
    expect(scopedRecording({ ...value, history: { items: [record, record] } }, ['5511'], 'r1')).toBeUndefined()
    expect(scopedRecording({ ...value, history: { items: [{ ...record, recordingStatus: 'pending' }] } }, ['5511'], 'r1')).toBeUndefined()
    value.capabilities!.history = false
    expect(scopedRecording(value, ['5511'], 'r1')).toBeUndefined()
  })

  test('bootstrap must confirm history support before a restricted history request', async () => {
    const app = setup()
    let resolve!: (value: VoipBootstrap) => void
    app.api.voipBootstrap.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = app.loadVoip()
    expect(app.api.voipHistory).not.toHaveBeenCalled()
    resolve(state())
    await pending
    expect(app.api.voipHistory).toHaveBeenCalledWith(expect.objectContaining({ page: 2, search: 'cliente', startDate: '2026-01-01' }))
    const unsupported = state()
    unsupported.capabilities!.history = false
    app.api.voipBootstrap.mockResolvedValueOnce(unsupported)
    await app.loadVoip()
    await app.loadVoipHistory(3)
    await app.handleClick(click('reset-voip-history'))
    expect(app.api.voipHistory).toHaveBeenCalledTimes(1)
    expect(app.voip.history).toBeUndefined()
  })

  test('pagination keeps filters; reset clears filters and requests page one', async () => {
    const app = setup()
    await app.handleClick(click('voip-history-page', { page: '1' }))
    expect(app.api.voipHistory).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: 'cliente', startDate: '2026-01-01' }))
    await app.handleClick(click('reset-voip-history'))
    expect(app.api.voipHistory).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: '', startDate: '', endDate: '' }))
  })

  test('filter form is narrowly allowed only with history capability', async () => {
    const app = setup()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement')
    const OriginalData = globalThis.FormData
    class FakeForm { dataset = { form: 'voip-history-filter' } }
    const data = new OriginalData()
    data.set('search', ' nova busca ')
    data.set('startDate', '2026-02-01')
    data.set('endDate', '2026-02-28')
    Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: FakeForm })
    globalThis.FormData = jest.fn(() => data) as unknown as typeof FormData
    try {
      await app.handleSubmit({ target: new FakeForm(), preventDefault: jest.fn() })
      expect(app.api.voipHistory).toHaveBeenCalledWith(expect.objectContaining({ page: 1, search: 'nova busca', startDate: '2026-02-01', endDate: '2026-02-28' }))
      app.voip.capabilities.history = false
      await app.handleSubmit({ target: new FakeForm(), preventDefault: jest.fn() })
      expect(app.api.voipHistory).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.FormData = OriginalData
      if (original) Object.defineProperty(globalThis, 'HTMLFormElement', original)
      else Reflect.deleteProperty(globalThis, 'HTMLFormElement')
    }
  })

  test('owned playback and download work and release replaced/download URLs', async () => {
    const app = setup()
    const originals = ['CSS', 'document', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    const play = jest.fn().mockResolvedValue(undefined)
    app.root = { querySelector: () => ({ play }) }
    const anchor = { href: '', download: '', click: jest.fn() }
    const timers: Array<() => void> = []
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => anchor } })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (fn: () => void) => timers.push(fn) } })
    const create = jest.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:play').mockReturnValueOnce('blob:download')
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    try {
      app.voipRecordingUrls.r1 = 'blob:previous'
      await app.handleClick(click('play-voip-recording', { recordId: 'r1' }))
      expect(app.api.voipRecording).toHaveBeenCalledWith('r1')
      expect(app.voipRecordingUrls.r1).toBe('blob:play')
      expect(revoke).toHaveBeenCalledWith('blob:previous')
      expect(play).toHaveBeenCalled()
      await app.handleClick(click('download-voip-recording', { recordId: 'r1', recordingExtension: 'wav' }))
      expect(anchor.click).toHaveBeenCalled()
      expect(anchor.download).toBe('r1.wav')
      timers.forEach(fn => fn())
      expect(revoke).toHaveBeenCalledWith('blob:download')
    } finally {
      create.mockRestore()
      revoke.mockRestore()
      originals.forEach(([name, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      })
    }
  })

  test.each(['play-voip-recording', 'download-voip-recording'])('rejects forged or unsupported %s before requesting audio', async action => {
    const app = setup()
    await app.handleClick(click(action, { recordId: 'foreign' }))
    await app.handleClick(click(action, { recordId: 'unknown' }))
    app.voip.capabilities.recordings = false
    await app.handleClick(click(action, { recordId: 'r1' }))
    expect(app.api.voipRecording).not.toHaveBeenCalled()
  })

  test('revokes stale object URLs when the history page or capabilities change', () => {
    const app = setup()
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    try {
      app.voipRecordingUrls = { foreign: 'blob:foreign', r1: 'blob:owned' }
      app.cleanScopedHistory()
      expect(revoke).toHaveBeenCalledWith('blob:foreign')
      expect(app.voipRecordingUrls).toEqual({ r1: 'blob:owned' })
      app.voip.capabilities.recordings = false
      app.cleanScopedHistory()
      expect(revoke).toHaveBeenCalledWith('blob:owned')
      expect(app.voipRecordingUrls).toEqual({})
    } finally { revoke.mockRestore() }
  })

  test('audio response cannot cross logout/login boundaries', async () => {
    let resolve!: (value: Response) => void
    const api = new ApiClient('', jest.fn(() => new Promise<Response>(done => { resolve = done })))
    api.setToken('mgr_login_one')
    const pending = api.voipRecording('r1')
    api.setToken('mgr_login_two')
    resolve(new Response('audio'))
    await expect(pending).rejects.toThrow('Requisição descartada')
  })
})
