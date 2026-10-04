import { MobileCompanionsPanel, formatCompanionCode } from '../../frontend/features/mobile_companions_panel'

test('server-only device is visible without invented date or unsupported revoke button', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
  panel.rows = [{ deviceJid: '123:40@s.whatsapp.net', canRevoke: false }]
  const html = panel.html({ mobilePrimaryDraftId: 'test' }, false)
  expect(html).toContain('Dispositivo 40')
  expect(html).toContain('Data não disponível')
  expect(html).toContain('Sem registro local')
  expect(html).not.toContain('data-action="companion-revoke"')
  expect(html).not.toContain('Invalid Date')
})
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

test('pairing code remains available alongside QR capture without a raw QR input', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any)
  const html = panel.html({ mobilePrimaryDraftId: 'test' }, false)
  expect(html).toContain('data-form="companion-code"')
  expect(html).not.toContain('data-form="companion-qr"')
  for (const marker of ['companion-image', 'companion-camera', 'companion-stop-camera', 'data-companion-video', 'QR Code']) expect(html).toContain(marker)
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

test('QR image and camera controls are available when idle, disabled while pairing and hidden from restricted users', () => {
  const panel = new MobileCompanionsPanel({} as any, jest.fn(), {} as any) as any
  const session = { mobilePrimaryDraftId: 'test' } as any
  const html = panel.html(session, false)
  expect(html).toContain('data-form="companion-image"')
  expect(html).toContain('data-action="companion-camera" >')
  expect(html).toContain('data-companion-video')
  panel.busy = true
  expect(panel.html(session, false)).toContain('data-action="companion-camera" disabled')
  expect(panel.html(session, true)).not.toContain('data-form="companion-image"')
})

test.each(['qr', 'code'])('history checkbox sends opt-out for %s and keeps it across rendering', async action => {
  const api = { request: jest.fn().mockResolvedValueOnce({ id: 'op' }).mockResolvedValue({ state: 'done' }) }
  const panel = new MobileCompanionsPanel(api as any, jest.fn(), {} as any) as any
  panel.device = 'test'
  expect(panel.html({ mobilePrimaryDraftId: 'test' }, false)).toContain('data-companion-history checked')
  panel.setSendHistory(false)
  expect(panel.html({ mobilePrimaryDraftId: 'test' }, false)).not.toContain('data-companion-history checked')
  await panel.command(action, 'test-value')
  await Promise.resolve()
  expect(JSON.parse(api.request.mock.calls[0][1].body)).toEqual({ action, value: 'test-value', confirm: true, sendHistory: false })
  panel.busy = true; panel.setSendHistory(true)
  expect(panel.sendHistory).toBe(false)
  panel.reset()
  expect(panel.sendHistory).toBe(true)
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
