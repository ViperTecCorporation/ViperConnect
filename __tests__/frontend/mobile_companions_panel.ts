import { MobileCompanionsPanel } from '../../frontend/features/mobile_companions_panel'
import * as qrReader from '../../frontend/features/qr_reader'
test('renders enabled controls without claiming an empty list and hides admin controls from users', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any)
  const session = { mobilePrimaryDraftId: 'test' }
  expect(panel.html(session, false)).toContain('companion-code')
  expect(panel.html(session, false)).not.toContain('Nenhum vínculo registrado')
  expect(panel.html(session, false)).not.toContain('disabled')
  expect(panel.html(session, true)).not.toContain('companion-code')
})

describe('camera consent and lifetime', () => {
  const windowBefore = (globalThis as any).window
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  afterEach(() => {
    (globalThis as any).window = windowBefore
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore)
    else delete (globalThis as any).navigator
    jest.restoreAllMocks()
  })
  test('asks consent before capture and sends a fresh QR without a second prompt', async () => {
    const confirm = jest.fn(() => true), stop = jest.fn()
    ;(globalThis as any).window = { confirm }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } } })
    jest.spyOn(qrReader, 'createQrReader').mockResolvedValue({ detect: () => [{ rawValue: 'fresh-qr' }] })
    const video = { isConnected: true, play: jest.fn().mockResolvedValue(undefined) }
    const panel = new MobileCompanionsPanel({} as any, jest.fn(), { querySelector: () => video } as any) as any
    panel.device = 'test'; panel.command = jest.fn().mockResolvedValue(undefined)
    await panel.action('companion-camera'); await Promise.resolve()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(panel.command).toHaveBeenCalledWith('qr', 'fresh-qr')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(panel.isCapturing).toBe(false)
  })
  test('stopping while permission is pending closes the arriving stream without scanning', async () => {
    ;(globalThis as any).window = { confirm: () => true }
    let resolve: any
    const stop = jest.fn(), detect = jest.fn()
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(ok => { resolve = ok }) } } })
    jest.spyOn(qrReader, 'createQrReader').mockResolvedValue({ detect })
    const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
    panel.device = 'test'
    const pending = panel.action('companion-camera'); await Promise.resolve(); await Promise.resolve()
    await panel.action('companion-stop-camera')
    resolve({ getTracks: () => [{ stop }] }); await pending
    expect(stop).toHaveBeenCalledTimes(1); expect(detect).not.toHaveBeenCalled()
  })
  test('declining consent never loads the decoder or opens camera', async () => {
    ;(globalThis as any).window = { confirm: () => false }
    const reader = jest.spyOn(qrReader, 'createQrReader')
    const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
    panel.device = 'test'; await panel.action('companion-camera')
    expect(reader).not.toHaveBeenCalled()
  })
})
test('open consults existing worker and reset stops camera and discards responses', async () => {
  const render = jest.fn(), stop = jest.fn()
  let resolve: any
  const api = { request: jest.fn().mockImplementation(() => new Promise(ok => { resolve = ok })) }
  const panel = new MobileCompanionsPanel(api as any, render, {} as any) as any
  panel.open('test')
  expect(api.request.mock.calls[0][0]).toBe('/manager/mobile-devices/test/companions')
  panel.stream = { getTracks: () => [{ stop }] }
  panel.reset(); resolve({ id: 'pending' }); await Promise.resolve(); await Promise.resolve()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(panel.device).toBe('')
})
