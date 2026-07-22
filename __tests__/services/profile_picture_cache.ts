import { profilePictureCacheIds } from '../../src/services/profile_picture_cache'

describe('profilePictureCacheIds', () => {
  test('keeps LID as the canonical cache identity', () => {
    expect(profilePictureCacheIds('190280070385782@lid')[0]).toBe('190280070385782@lid')
  })

  test('removes the device suffix without losing the LID server', () => {
    expect(profilePictureCacheIds('190280070385782:35@lid')[0]).toBe('190280070385782@lid')
  })

  test('keeps groups as group JIDs', () => {
    expect(profilePictureCacheIds('120363000000@g.us')[0]).toBe('120363000000@g.us')
  })

  test('preserves the legacy PN cache key for compatibility', () => {
    expect(profilePictureCacheIds('5566996328386@s.whatsapp.net')).toContain('+5566996328386')
  })

  test('does not generate a cache key for empty input', () => {
    expect(profilePictureCacheIds('')).toEqual([])
  })
})
