import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { isFastStartMp4 } from '../../src/services/mp4_faststart'

export const box = (type: string, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8); header.writeUInt32BE(8 + payload.length); header.write(type, 4)
  return Buffer.concat([header, payload])
}
test.each([
  ['ready', ['ftyp', 'moov', 'mdat'], 'isom', true],
  ['tail index', ['ftyp', 'mdat', 'moov'], 'isom', false],
  ['QuickTime', ['ftyp', 'moov', 'mdat'], 'qt  ', false],
  ['fragmented', ['ftyp', 'moov', 'moof', 'mdat'], 'iso6', false],
  ['missing media', ['ftyp', 'moov'], 'isom', false],
] as const)('%s', async (_name, types, brand, expected) => {
  const dir = await mkdtemp(join(tmpdir(), 'unoapi-mp4-check-'))
  try {
    const path = join(dir, 'input')
    await writeFile(path, Buffer.concat(types.map(type => box(type, type === 'ftyp' ? Buffer.concat([Buffer.from(brand), Buffer.alloc(4)]) : Buffer.alloc(0)))))
    expect(await isFastStartMp4(path)).toBe(expected)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('rejects truncated and oversized boxes; supports extended-size and final size-zero boxes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unoapi-mp4-check-'))
  try {
    const path = join(dir, 'input'); const ftyp = box('ftyp', Buffer.from('isom0000'))
    const extended = Buffer.alloc(16); extended.writeUInt32BE(1); extended.write('moov', 4); extended.writeBigUInt64BE(BigInt(16), 8)
    const last = box('mdat'); last.writeUInt32BE(0)
    await writeFile(path, Buffer.concat([ftyp, extended, last]))
    expect(await isFastStartMp4(path)).toBe(true)
    for (const bytes of [Buffer.from('bad'), Buffer.concat([ftyp, box('moov'), Buffer.from('bad')]), Buffer.from([255,255,255,255,109,100,97,116])]) {
      await writeFile(path, bytes); expect(await isFastStartMp4(path)).toBe(false)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
