import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { IANA_TLDS } from './iana_tlds'

const SCHEME_URL = /\bhttps?:\/\/[^\s<>"']+/gi
// Protect the whole email token, including dotted local parts and domain suffixes.
const EMAIL_TOKEN = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/g
const BARE_DOMAIN = /(?<![@\w-])((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]+|[a-z]{2,63})(?![a-z0-9-])(?::\d{1,5})?(?:\/[^\s<>"']*)?)/gi
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

/** Protective recognition, not payment/CRC validation. Never depend on a bank URL. */
export const containsPixCopyPaste = (text: string) => {
  const start = text.indexOf('000201')
  return start >= 0 && /0014br\.gov\.bcb\.pix/i.test(text.slice(start + 6))
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
  // A dot and letters are not sufficient: usernames and file suffixes also match.
  // Keep this lookup local; DNS/HTTP availability must not rewrite message text.
  return IANA_TLDS.has(tld)
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
  if (containsPixCopyPaste(text)) return undefined
  for (const match of text.matchAll(SCHEME_URL)) {
    const candidate = stripTrailingPunctuation(match[0])
    if (isValidHttpUrl(candidate)) return candidate
  }
  return undefined
}

export const normalizeAutomaticLinkPreview = (text: string): AutomaticLinkPreview => {
  // Disable the whole message: the SDK could otherwise pick a URL inside the code.
  if (containsPixCopyPaste(text)) return { text, enabled: false }
  if (findFirstAutomaticPreviewUrl(text)) return { text, enabled: true }

  const protectedTokens = [...text.matchAll(EMAIL_TOKEN), ...text.matchAll(SCHEME_URL)]
  for (const match of text.matchAll(BARE_DOMAIN)) {
    const candidate = stripTrailingPunctuation(match[1] || '')
    const index = match.index ?? -1
    if (!candidate || index < 0 || text.slice(Math.max(0, index - 3), index) === '://') continue
    if (protectedTokens.some((token) => index < token.index! + token[0].length && index + candidate.length > token.index!)) continue
    if (!isValidHttpUrl(`https://${candidate}`)) continue
    return {
      text: `${text.slice(0, index)}https://${candidate}${text.slice(index + candidate.length)}`,
      enabled: true,
    }
  }

  return { text, enabled: false }
}
