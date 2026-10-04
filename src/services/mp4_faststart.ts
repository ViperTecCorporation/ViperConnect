import { open } from 'fs/promises'

/** Inspect top-level ISO BMFF boxes without loading media bytes into memory.
 * Unknown, truncated, fragmented or non-MP4 layouts use the normal remux path.
 */
export async function isFastStartMp4(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const header = Buffer.alloc(16)
    let offset = 0; let mp4 = false; let moov = false; let media = false
    for (let boxes = 0; offset < size && boxes < 10000; boxes++) {
      if (size - offset < 8) return false
      const { bytesRead } = await file.read(header, 0, Math.min(16, size - offset), offset)
      if (bytesRead < 8) return false
      const type = header.toString('ascii', 4, 8)
      let length = header.readUInt32BE(0); let headerSize = 8
      if (length === 1) {
        if (bytesRead < 16) return false
        const large = header.readBigUInt64BE(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false
        length = Number(large); headerSize = 16
      } else if (length === 0) length = size - offset
      if (length < headerSize || length > size - offset) return false
      if (type === 'ftyp') {
        if (offset !== 0 || length < headerSize + 8) return false
        const brand = Buffer.alloc(4)
        if ((await file.read(brand, 0, 4, offset + headerSize)).bytesRead !== 4) return false
        mp4 = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1'].includes(brand.toString('ascii'))
      }
      if (type === 'moof') return false
      if (type === 'moov') { if (media || moov) return false; moov = true }
      if (type === 'mdat') { if (!moov) return false; media = true }
      offset += length
    }
    return offset === size && mp4 && moov && media
  } finally { await file.close() }
}
