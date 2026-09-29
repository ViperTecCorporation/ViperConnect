import { SendError } from './send_error'
import { validatePrivacyInput } from './profile_privacy_input'

export type ProfileField = 'name' | 'about' | 'username' | 'business' | 'picture' | 'cover' | 'account_email' | 'privacy'
export interface ProfileCommand { action: 'get' | 'set' | 'delete'; field?: ProfileField; value?: any }
const fail = (field: string): never => { throw new SendError(400, `invalid_profile_${field}`) }
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: any, allowed: string[]) => { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail('fields') }
const string = (v: any, max: number) => typeof v === 'string' && v.length <= max

/** Validate before RPC and again on the owning worker; never accept a target JID. */
export function validateProfileCommand(command: ProfileCommand): ProfileCommand {
  keys(command, ['action', 'field', 'value'])
  const { action, field, value } = command
  if (field === 'privacy') {
    if (action === 'get' && value === undefined) return command
    if (action !== 'set') fail('privacy_action')
    validatePrivacyInput(value)
    return command
  }
  if (field === 'account_email') {
    if (action === 'get' && value === undefined) return command
    if (action !== 'set') fail('email_action')
    keys(value, ['operation', 'email', 'code'])
    if (value.operation === 'set') {
      if (!string(value.email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.code !== undefined) fail('email')
    } else if (value.operation === 'verify') {
      if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code) || value.email !== undefined) fail('email_code')
    } else if (['request_code', 'confirm'].includes(value.operation)) {
      if (value.email !== undefined || value.code !== undefined) fail('email_fields')
    } else fail('email_action')
    return command
  }
  if (action === 'get' && field === undefined && value === undefined) return command
  if (!field || !['name', 'about', 'username', 'business', 'picture', 'cover'].includes(field)) fail('field')
  if (action === 'delete') {
    if (!['picture', 'cover', 'username'].includes(field!)) fail('delete')
    if (field === 'cover' ? !string(value, 128) || !/^[\w-]+$/.test(value) : value !== undefined) fail('delete')
    return command
  }
  if (action !== 'set') fail('action')
  if (field === 'name' && !string(value, 128)) fail('name')
  if (field === 'about' && !string(value, 139)) fail('about')
  if (field === 'username') {
    // Zapo 1.9 protocol/username: keep the same local rules before entering RPC.
    if (!string(value, 35) || !/^[a-zA-Z0-9_.]{3,35}$/.test(value) || !/[a-z]/i.test(value)
      || value.startsWith('.') || value.endsWith('.') || value.includes('..')
      || /^www\./i.test(value) || /\.(com|org|net|int|edu|gov|mil|arpa|html|htm|txt|xml)$/i.test(value)
      || /whatsapp|instagram|facebook|oculus/i.test(value)) fail('username')
  }
  if (field === 'picture' || field === 'cover') {
    if (!string(value, 7_000_000) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value.length) fail('image_base64')
    if (Buffer.from(value, 'base64').length > 5 * 1024 * 1024) fail('image_size')
  }
  if (field === 'business') validateBusinessProfile(value)
  return command
}

export function validateBusinessProfile(value: any): void {
  keys(value, ['description', 'address', 'email', 'websites', 'categories', 'businessHours', 'latitude', 'longitude'])
  if (!Object.keys(value).length) fail('business_empty')
  for (const field of ['description', 'address', 'email']) {
    if (value[field] !== undefined && !string(value[field], field === 'email' ? 254 : 1024)) fail(field)
  }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) fail('email')
  if (value.websites !== undefined) {
    if (!Array.isArray(value.websites) || value.websites.length > 2) fail('websites')
    for (const site of value.websites) {
      keys(site, ['url'])
      if (!string(site.url, 2048)) fail('websites')
      try { if (!['http:', 'https:'].includes(new URL(site.url).protocol)) fail('websites') } catch { fail('websites') }
    }
  }
  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories) || value.categories.length > 10) fail('categories')
    for (const category of value.categories) { keys(category, ['id']); if (!string(category.id, 64) || !/^\d+$/.test(category.id)) fail('category_id') }
  }
  for (const [field, max] of [['latitude', 90], ['longitude', 180]] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || Math.abs(value[field]) > max)) fail(field)
  }
  if ((value.latitude === undefined) !== (value.longitude === undefined)) fail('coordinates_pair')
  if (value.businessHours !== undefined) {
    const hours = value.businessHours
    keys(hours, ['timezone', 'config'])
    if (hours.timezone !== undefined) {
      if (!string(hours.timezone, 100) || !hours.timezone) fail('timezone')
      try { new Intl.DateTimeFormat('en', { timeZone: hours.timezone }) } catch { fail('timezone') }
    }
    if (!Array.isArray(hours.config) || hours.config.length > 7) fail('hours')
    const days = new Set()
    for (const day of hours.config) {
      keys(day, ['dayOfWeek', 'mode', 'openTime', 'closeTime'])
      if (!['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(day.dayOfWeek) || days.has(day.dayOfWeek)) fail('day')
      days.add(day.dayOfWeek)
      if (!['specific_hours', 'open_24h', 'appointment_only'].includes(day.mode)) fail('hours_mode')
      if (day.mode === 'specific_hours') {
        if (![day.openTime, day.closeTime].every(n => Number.isInteger(n) && n >= 0 && n <= 1439) || day.closeTime <= day.openTime) fail('hours_range')
      } else if (day.openTime !== undefined || day.closeTime !== undefined) fail('hours_range')
    }
  }
}
