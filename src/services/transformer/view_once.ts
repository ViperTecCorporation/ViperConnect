/** Inspect only the message envelope, never quoted messages or media bytes. */
export const isViewOnceContent = (content: any, depth = 0): boolean => {
  if (!content || depth > 12) return false
  for (const kind of ['imageMessage', 'videoMessage', 'audioMessage']) {
    if (content[kind]?.viewOnce === true) return true
  }
  for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    if (content[wrapper]?.message) return true
  }
  for (const wrapper of ['ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage']) {
    if (isViewOnceContent(content[wrapper]?.message, depth + 1)) return true
  }
  return false
}
