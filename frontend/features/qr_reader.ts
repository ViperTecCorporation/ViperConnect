export type QrDecoder = (pixels: Uint8ClampedArray, width: number, height: number, options: { inversionAttempts: 'attemptBoth' }) => { data: string } | null
let loading: Promise<QrDecoder> | undefined

/** Pinned, same-origin library. No camera or network image upload here. */
export function loadQrDecoder(): Promise<QrDecoder> {
  const installed = (globalThis as any).jsQR as QrDecoder | undefined
  if (installed) return Promise.resolve(installed)
  if (loading) return loading
  loading = new Promise<QrDecoder>((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => { clearTimeout(timeout); script.remove(); loading = undefined; reject(new Error('Não foi possível carregar o leitor de QR. Atualize a página e tente novamente.')) }
    const timeout = setTimeout(fail, 10000)
    script.src = '/app/vendor/jsqr-1.4.0.js'
    script.async = true
    script.onerror = fail
    script.onload = () => {
      const decoder = (globalThis as any).jsQR as QrDecoder | undefined
      if (!decoder) { fail(); return }
      clearTimeout(timeout); resolve(decoder)
    }
    document.head.appendChild(script)
  })
  return loading
}

export function decodeQrPixels(decoder: QrDecoder, pixels: Uint8ClampedArray, width: number, height: number): Array<{ rawValue: string }> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4194304 || pixels.length !== width * height * 4) throw new Error('Dimensões inválidas para leitura do QR Code.')
  const result = decoder(pixels, width, height, { inversionAttempts: 'attemptBoth' })
  return result?.data ? [{ rawValue: result.data }] : []
}

/** Reuses a bounded canvas; decoding happens locally, only while requested. */
export async function createQrReader() {
  const decoder = await loadQrDecoder()
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Não foi possível preparar a leitura de imagem.')
  return {
    detect(source: ImageBitmap | HTMLVideoElement): Array<{ rawValue: string }> {
      const width = 'videoWidth' in source ? source.videoWidth : source.width
      const height = 'videoHeight' in source ? source.videoHeight : source.height
      if (!width || !height) return []
      const scale = Math.min(1, 2048 / Math.max(width, height))
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      return decodeQrPixels(decoder, context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    },
  }
}
