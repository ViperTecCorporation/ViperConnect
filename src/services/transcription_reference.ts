import { createHash } from 'crypto'
import { getRedis } from './redis'

export const transcriptionId = (phone: string, conversation: string, audioId: string) => {
  if (!phone || !conversation || !audioId) throw new Error('transcription_reference_required')
  // The original Uno audio ID is stable across PN/LID/username aliases.
  const scope = conversation.endsWith('@g.us') ? conversation : 'direct'
  return `uno-transcription:v2:${createHash('sha256').update(JSON.stringify([phone, scope, audioId])).digest('hex')}`
}

const referenceKey = (phone: string, id: string) => `unoapi-transcription-reference:${phone}:${id}`

export const saveTranscriptionReference = async (phone: string, conversation: string, audioId: string) => {
  const id = transcriptionId(phone, conversation, audioId)
  const redis = await getRedis()
  // SET without expiry also removes any previous TTL. References survive reconnects.
  await redis.set(referenceKey(phone, id), JSON.stringify({ conversation, audioId }))
  return id
}

export const loadTranscriptionReference = async (phone: string, id: string): Promise<string | undefined> => {
  if (!id.startsWith('uno-transcription:')) return undefined
  const redis = await getRedis()
  const raw = await redis.get(referenceKey(phone, id))
  if (!raw) return undefined
  const value = JSON.parse(raw)
  if (typeof value?.audioId !== 'string' || typeof value?.conversation !== 'string') throw new Error('invalid_transcription_reference')
  const expected = id.startsWith('uno-transcription:v2:')
    ? transcriptionId(phone, value.conversation, value.audioId)
    : `uno-transcription:${createHash('sha256').update(JSON.stringify([phone, value.conversation, value.audioId])).digest('hex')}`
  if (expected !== id) {
    throw new Error('invalid_transcription_reference')
  }
  return value.audioId
}
