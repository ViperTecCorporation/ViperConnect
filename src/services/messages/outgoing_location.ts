import { SendError } from '../send_error'

export type OutgoingLocation = { latitude: number; longitude: number; name?: string; address?: string }

// Accept decimal strings used by Cloud API clients, without coercing null/boolean/empty to zero.
export const normalizeOutgoingLocation = (input: unknown): OutgoingLocation => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SendError(400, 'location_required')
  const value = input as Record<string, unknown>
  const result = {} as OutgoingLocation
  for (const [field, limit] of [['latitude', 90], ['longitude', 180]] as const) {
    const raw = value[field]
    const validType = typeof raw === 'number'
      || (typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()))
    const number = validType ? Number(raw) : NaN
    if (!Number.isFinite(number) || Math.abs(number) > limit) throw new SendError(400, `invalid_location_${field}`)
    result[field] = number
  }
  for (const field of ['name', 'address'] as const) {
    if (value[field] === undefined) continue
    if (typeof value[field] !== 'string') throw new SendError(400, `invalid_location_${field}`)
    result[field] = value[field] as string
  }
  return result
}
