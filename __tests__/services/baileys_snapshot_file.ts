import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BufferJSON } from '@whiskeysockets/baileys'
import { parseBaileysAuthStorageKey, readBaileysFileSnapshot } from '../../src/services/zapo/baileys_snapshot'

describe('Baileys file snapshot', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'unoapi-zapo-migration-'))
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  test('parses credentials and key categories without confusing category hyphens', () => {
    expect(parseBaileysAuthStorageKey('5566', 'app-state-sync-key-my-key.json')).toEqual({
      type: 'app-state-sync-key',
      id: 'my-key',
    })
  })

  test('returns no snapshot when the Baileys credentials do not exist', () => {
    expect(readBaileysFileSnapshot('5566', directory)).toBeUndefined()
  })

  test('reads a Baileys multi-file session into the migration shape', () => {
    const sessionDirectory = join(directory, 'sessions', '5566')
    mkdirSync(sessionDirectory, { recursive: true })
    const write = (file: string, value: unknown) =>
      writeFileSync(join(sessionDirectory, file), JSON.stringify(value, BufferJSON.replacer))
    write('creds.json', { registered: true, registrationId: 10 })
    write('pre-key-7.json', { public: 'public-key', private: 'private-key' })

    const snapshot = readBaileysFileSnapshot('5566', directory)

    expect(snapshot?.creds).toEqual(expect.objectContaining({ registered: true, registrationId: 10 }))
    expect(snapshot?.keys['pre-key']?.['7']).toEqual({ public: 'public-key', private: 'private-key' })
  })
})
