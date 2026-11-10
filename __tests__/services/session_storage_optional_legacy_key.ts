import { sessionBackupPassword } from '../../src/services/session_storage/backup_runtime'
const fs = require('node:fs')
const saved = process.env.SESSION_STORAGE_BACKUP_KEY_FILE
afterEach(() => { jest.restoreAllMocks(); if (saved === undefined) delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE; else process.env.SESSION_STORAGE_BACKUP_KEY_FILE = saved })

test('no configured legacy key does not read any file or prevent a plain backup', () => {
  delete process.env.SESSION_STORAGE_BACKUP_KEY_FILE
  const read = jest.spyOn(fs, 'readFileSync')
  expect(sessionBackupPassword()).toBeUndefined(); expect(read).not.toHaveBeenCalled()
})

test.each(['missing', 'short', 'valid'])('optional legacy key file %s is never deleted or required for plain format', kind => {
  process.env.SESSION_STORAGE_BACKUP_KEY_FILE = 'synthetic-legacy-backup.key'
  const read = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
    if (kind === 'missing') throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' })
    return kind === 'short' ? 'short' : '  synthetic-dedicated-backup-legacy-key\n'
  })
  expect(sessionBackupPassword()).toBe(kind === 'valid' ? 'synthetic-dedicated-backup-legacy-key' : undefined)
  expect(read).toHaveBeenCalledWith('synthetic-legacy-backup.key', 'utf8')
})
