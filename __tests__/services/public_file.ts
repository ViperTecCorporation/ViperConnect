import path from 'path'
import { realpath, stat } from 'fs/promises'
import { resolvePublicFile } from '../../src/utils/public_file'

jest.mock('fs/promises', () => ({ realpath: jest.fn(), stat: jest.fn() }))

describe('public file containment', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    ;(realpath as jest.Mock).mockImplementation(async value => path.resolve(value))
    ;(stat as jest.Mock).mockResolvedValue({ isFile: () => true })
  })
  test.each(['../../package.json', '../package.json', '/etc/passwd', 'C:/Windows/test', '..\\package.json', 'nested/../../package.json', '.env', 'nested/.secret', 'file\0.txt', ''])('rejects unsafe path %s', async file => {
    expect(await resolvePublicFile('./docs', file)).toBeUndefined()
  })
  test.each(['README.md', 'pt-BR/AMBIENTE.md', '.env.example'])('allows public file %s', async file => {
    expect(await resolvePublicFile('./docs', file)).toBe(path.resolve('./docs', file))
  })
  test('rejects a symlink escaping the root', async () => {
    ;(realpath as jest.Mock).mockResolvedValueOnce(path.resolve('./docs')).mockResolvedValueOnce(path.resolve('./package.json'))
    expect(await resolvePublicFile('./docs', 'link')).toBeUndefined()
  })
  test('rejects directories and missing files', async () => {
    ;(stat as jest.Mock).mockResolvedValue({ isFile: () => false })
    expect(await resolvePublicFile('./docs', 'folder')).toBeUndefined()
    ;(realpath as jest.Mock).mockRejectedValue(new Error('ENOENT'))
    expect(await resolvePublicFile('./docs', 'missing')).toBeUndefined()
  })
})
