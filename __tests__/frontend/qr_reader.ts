import * as QRCode from 'qrcode'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decodeQrPixels } from '../../frontend/features/qr_reader'
const decoder = require('../../public/app/vendor/jsqr-1.4.0.js')
const content = `test-reference,${Array(3).fill(Buffer.alloc(32, 7).toString('base64')).join(',')},1`

function pixels(text: string, inverted = false, rotated = false) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' }), size = (qr.modules.size + 8) * 5
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / 5) - 4, col = Math.floor(x / 5) - 4
    const dark = row >= 0 && col >= 0 && row < qr.modules.size && col < qr.modules.size && qr.modules.get(row, col)
    const color = (!!dark !== inverted) ? 0 : 255
    const offset = (rotated ? x * size + size - y - 1 : y * size + x) * 4
    data[offset] = color; data[offset + 1] = color; data[offset + 2] = color; data[offset + 3] = 255
  }
  return { data, size }
}
test.each([[false, false], [true, false], [false, true]])('reads actual generated QR pixels inverted=%s rotated=%s without BarcodeDetector', (inverted, rotated) => {
  const image = pixels(content, inverted, rotated)
  expect(decodeQrPixels(decoder, image.data, image.size, image.size)).toEqual([{ rawValue: content }])
})
test('reads the newest QR content without caching a previous capture', () => {
  for (const value of [content, content.replace('test-reference', 'new-reference')]) {
    const image = pixels(value)
    expect(decodeQrPixels(decoder, image.data, image.size, image.size)[0].rawValue).toBe(value)
  }
})
test('blank images and invalid dimensions never invent a QR', () => {
  expect(decodeQrPixels(decoder, new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100)).toEqual([])
  expect(() => decodeQrPixels(decoder, new Uint8ClampedArray(4), 2049, 2049)).toThrow('Dimensões')
  expect(() => decodeQrPixels(decoder, new Uint8ClampedArray(4), 2, 2)).toThrow('Dimensões')
})
test('vendored source is identical to pinned npm distribution ignoring final newline and CRLF', () => {
  const source = readFileSync('public/app/vendor/jsqr-1.4.0.js', 'utf8').replace(/\r\n/g, '\n').trimEnd()
  expect(createHash('sha256').update(source).digest('hex')).toBe('bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859')
  expect(readFileSync('public/app/vendor/jsqr-LICENSE.txt', 'utf8')).toContain('Apache License')
})

describe('local lazy loader and bounded canvas', () => {
  const originalDocument = (globalThis as any).document
  afterEach(() => { (globalThis as any).document = originalDocument; delete (globalThis as any).jsQR; jest.useRealTimers() })
  test('shares a single same-origin script and decodes canvas locally', async () => {
    jest.resetModules()
    const module = require('../../frontend/features/qr_reader')
    const script: any = { remove: jest.fn() }, appendChild = jest.fn()
    ;(globalThis as any).document = { createElement: () => script, head: { appendChild } }
    const first = module.loadQrDecoder(), second = module.loadQrDecoder()
    expect(first).toBe(second); expect(appendChild).toHaveBeenCalledTimes(1)
    expect(script.src).toBe('/app/vendor/jsqr-1.4.0.js')
    ;(globalThis as any).jsQR = decoder; script.onload(); expect(await first).toBe(decoder)
    const context = { drawImage: jest.fn(), getImageData: jest.fn().mockReturnValue({ data: new Uint8ClampedArray(4).fill(255) }) }
    const canvas: any = { getContext: () => context }
    ;(globalThis as any).document.createElement = () => canvas
    const reader = await module.createQrReader()
    expect(reader.detect({ width: 0, height: 0 })).toEqual([])
    expect(reader.detect({ width: 1, height: 1 })).toEqual([])
    expect(context.drawImage).toHaveBeenCalledTimes(1)
  })
  test('failed script can be retried and loader timeout is bounded', async () => {
    jest.useFakeTimers(); jest.resetModules()
    const module = require('../../frontend/features/qr_reader')
    const script: any = { remove: jest.fn() }
    ;(globalThis as any).document = { createElement: () => script, head: { appendChild: jest.fn() } }
    const first = module.loadQrDecoder(); const failure = expect(first).rejects.toThrow('carregar')
    script.onerror(); await failure
    const second = module.loadQrDecoder(); const timeout = expect(second).rejects.toThrow('carregar')
    await jest.advanceTimersByTimeAsync(10000); await timeout
    expect(script.remove).toHaveBeenCalledTimes(2)
  })
})
