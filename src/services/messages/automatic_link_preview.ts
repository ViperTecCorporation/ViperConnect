import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

const SCHEME_URL = /\bhttps?:\/\/[^\s<>"']+/gi
// Protect the whole email token, including dotted local parts and domain suffixes.
const EMAIL_TOKEN = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/g
const BARE_DOMAIN = /(?<![@\w-])((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>"']*)?)/gi
const TRAILING_PUNCTUATION = '.,;:!?\'"»›'
const FILE_EXTENSIONS = new Set([
  'apk', 'avi', 'csv', 'css', 'dmg', 'doc', 'docx', 'exe', 'gif', 'html', 'iso',
  'jpeg', 'jpg', 'js', 'json', 'mkv', 'mov', 'mp3', 'mp4', 'pdf', 'png', 'ppt',
  'pptx', 'rar', 'svg', 'tar', 'ts', 'txt', 'wav', 'webm', 'webp', 'xls', 'xlsx',
  'xml', 'zip',
])

export type AutomaticLinkPreview = {
  text: string
  enabled: boolean
}

const stripTrailingPunctuation = (value: string) => {
  let candidate = value
  while (candidate && TRAILING_PUNCTUATION.includes(candidate.at(-1) || '')) {
    candidate = candidate.slice(0, -1)
  }
  return candidate
}

const isValidPublicDomain = (hostname: string) => {
  const ascii = domainToASCII(hostname).toLowerCase().replace(/\.$/, '')
  if (!ascii || isIP(ascii) || ascii === 'localhost') return false
  const labels = ascii.split('.')
  if (labels.length < 2) return false
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false
  const tld = labels.at(-1) || ''
  if (FILE_EXTENSIONS.has(tld)) return false
  return /^xn--[a-z0-9-]+$/.test(tld) || /^[a-z]{2,63}$/.test(tld)
}

const isValidHttpUrl = (candidate: string) => {
  try {
    const parsed = new URL(candidate)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isValidPublicDomain(parsed.hostname)
  } catch {
    return false
  }
}

export const findFirstAutomaticPreviewUrl = (text: string) => {
  for (const match of text.matchAll(SCHEME_URL)) {
    const candidate = stripTrailingPunctuation(match[0])
    if (isValidHttpUrl(candidate)) return candidate
  }
  return undefined
}

export const normalizeAutomaticLinkPreview = (text: string): AutomaticLinkPreview => {
  if (findFirstAutomaticPreviewUrl(text)) return { text, enabled: true }

  const emails = Array.from(text.matchAll(EMAIL_TOKEN))
  for (const match of text.matchAll(BARE_DOMAIN)) {
    const candidate = stripTrailingPunctuation(match[1] || '')
    const index = match.index ?? -1
    if (!candidate || index < 0 || text.slice(Math.max(0, index - 3), index) === '://') continue
    if (emails.some((email) => index < email.index! + email[0].length && index + candidate.length > email.index!)) continue
    if (!isValidHttpUrl(`https://${candidate}`)) continue
    return {
      text: `${text.slice(0, index)}https://${candidate}${text.slice(index + candidate.length)}`,
      enabled: true,
    }
  }

  return { text, enabled: false }
}
