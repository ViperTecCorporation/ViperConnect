import { MobileCompanionsPanel, formatCompanionCode } from '../../frontend/features/mobile_companions_panel'
import * as qrReader from '../../frontend/features/qr_reader'

test.each([['abcd', 'ABCD'], ['abcd-efgh', 'ABCD-EFGH'], ['ab12 cd34', 'AB12-CD34'], ['ab!12_cd34xyz', 'AB12-CD34'], ['', '']])('formats pairing input %s', (input, expected) => {
  expect(formatCompanionCode(input)).toBe(expected)
})

test.each(['ABC', 'ABCDEFGHI', 'ABCD!EFG', ''])('does not submit invalid pairing code %s', async value => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
  panel.device = 'test'; panel.command = jest.fn()
  const data = new FormData(); data.set('value', value)
  await panel.submit('companion-code', data)
  expect(panel.command).not.toHaveBeenCalled()
  expect(panel.message).toContain('8 caracteres')
})

test('history is automatic only at pair time and manual action cannot send', async () => {
  const request = jest.fn()
  const panel = new MobileCompanionsPanel({ request } as any, jest.fn(), {} as any) as any
  panel.device = 'draft'; panel.rows = [{ deviceJid: '123:2@s.whatsapp.net', addedAtSeconds: 1 }]
  const html = panel.html({ mobilePrimaryDraftId: 'draft' }, false)
  expect(html).not.toContain('data-action="companion-history"')
  expect(html).toContain('sem corte por idade ou quantidade total')
  await panel.action('companion-history', '123:2@s.whatsapp.net'); expect(request).not.toHaveBeenCalled()
})
test('renders enabled controls without claiming an empty list and hides admin controls from users', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any)
  const session = { mobilePrimaryDraftId: 'test' }
  expect(panel.html(session, false)).toContain('companion-code')
  expect(panel.html(session, false)).not.toContain('Nenhum vínculo registrado')
  expect(panel.html(session, false)).not.toContain('disabled')
  expect(panel.html(session, true)).not.toContain('companion-code')
})

test('only pairing code is exposed; all QR entry points are absent from the panel', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any)
  const html = panel.html({ mobilePrimaryDraftId: 'test' }, false)
  expect(html).toContain('data-form="companion-code"')
  for (const marker of ['companion-qr', 'companion-image', 'companion-camera', 'companion-stop-camera', 'data-companion-video', 'QR Code']) expect(html).not.toContain(marker)
  expect(html).toContain('Inclui somente textos e vídeos')
})

test('groups devices and pairing with readable identity, escaped data and collapsed history', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
  panel.rows = [{ deviceJid: '123:34@s.whatsapp.net', addedAtSeconds: 1 }, { deviceJid: '<script>', addedAtSeconds: 1 }]
  const html = panel.html({ mobilePrimaryDraftId: 'test' }, false)
  expect(html).toContain('Dispositivo 34')
  expect(html).toContain('123:34@s.whatsapp.net')
  expect(html).toContain('class="companions-heading"')
  expect(html).toContain('class="companion-code-form"')
  expect(html).toContain('aria-describedby="companion-code-help"')
  expect(html).toContain('<details class="companion-history">')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('data-action="companion-revoke"')
})

test('pairing code keeps confirmation and normalization', async () => {
  const previous = (globalThis as any).window
  try {
    ;(globalThis as any).window = { confirm: jest.fn(() => true) }
    const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
    panel.device = 'test'; panel.command = jest.fn().mockResolvedValue(undefined)
    const data = new FormData(); data.set('value', 'abcd-efgh')
    await panel.submit('companion-code', data)
    expect(panel.command).toHaveBeenCalledWith('code', 'ABCDEFGH')
  } finally { (globalThis as any).window = previous }
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
