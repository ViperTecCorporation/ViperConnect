jest.mock('../../src/services/redis', () => ({ getRedis: jest.fn() }))
import { getRedis } from '../../src/services/redis'
import { createHash } from 'crypto'
import { transcriptionId, saveTranscriptionReference, loadTranscriptionReference } from '../../src/services/transcription_reference'

describe('transcription references', () => {
  const values = new Map<string, string>()
  const redis = { set: jest.fn(async (key, value) => { values.set(key, value) }), get: jest.fn(async key => values.get(key)) }
  beforeEach(() => { values.clear(); jest.clearAllMocks(); (getRedis as jest.Mock).mockResolvedValue(redis) })
  it('creates stable IDs isolated by session and conversation', () => {
    expect(transcriptionId('1', 'group@g.us', 'audio')).toBe(transcriptionId('1', 'group@g.us', 'audio'))
    expect(transcriptionId('1', 'group@g.us', 'audio')).not.toBe(transcriptionId('2', 'group@g.us', 'audio'))
    expect(transcriptionId('1', 'group@g.us', 'audio')).not.toBe(transcriptionId('1', 'other@g.us', 'audio'))
    expect(() => transcriptionId('1', 'group', '')).toThrow('transcription_reference_required')
  })
  it('persists without a TTL and reads only in the owning session', async () => {
    const id = await saveTranscriptionReference('1', 'group@g.us', 'audio')
    expect(redis.set.mock.calls[0]).toHaveLength(2)
    expect(await loadTranscriptionReference('1', id)).toBe('audio')
    expect(await loadTranscriptionReference('2', id)).toBeUndefined()
  })
  it('does not access Redis for an old UUID or normal message ID', async () => {
    expect(await loadTranscriptionReference('1', 'old-uuid')).toBeUndefined()
    expect(getRedis).not.toHaveBeenCalled()
  })
  it('loads references from the first schema without rewriting them', async () => {
    const id = `uno-transcription:${createHash('sha256').update(JSON.stringify(['1', 'contact@lid', 'audio'])).digest('hex')}`
    values.set(`unoapi-transcription-reference:1:${id}`, JSON.stringify({ conversation: 'contact@lid', audioId: 'audio' }))
    expect(await loadTranscriptionReference('1', id)).toBe('audio')
    expect(redis.set).not.toHaveBeenCalled()
  })
  it('does not depend on phone formatting, LID or username for a direct audio ID', () => {
    const expected = transcriptionId('1', '5511999999999', 'audio')
    for (const alias of ['+5511999999999', '5511999999999@s.whatsapp.net', '551199999999', '123@lid', '@username']) {
      expect(transcriptionId('1', alias, 'audio')).toBe(expected)
    }
    expect(transcriptionId('1', '123@g.us', 'audio')).not.toBe(expected)
  })
  it('propagates storage failures instead of interpreting them as missing references', async () => {
    ;(getRedis as jest.Mock).mockRejectedValueOnce(new Error('offline'))
    await expect(saveTranscriptionReference('1', 'group', 'audio')).rejects.toThrow('offline')
  })
  it('rejects a corrupted association', async () => {
    const id = await saveTranscriptionReference('1', 'group', 'audio')
    values.set(`unoapi-transcription-reference:1:${id}`, JSON.stringify({ conversation: 'other', audioId: 'different-audio' }))
    await expect(loadTranscriptionReference('1', id)).rejects.toThrow('invalid_transcription_reference')
  })
})
