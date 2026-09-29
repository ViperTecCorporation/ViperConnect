/** Never return decoder text: image metadata may contain private content. */
export function profileImageFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/exceeds pixel limit/i.test(message)) return 'pixel_limit_exceeded'
  if (/unsupported image format/i.test(message)) return 'unsupported_image_format'
  if (/no decoding plugin|unsupported codec|unsupported compression/i.test(message)) return 'decoder_unavailable'
  if (/corrupt|truncated|premature end|unexpected end|invalid.*header|bad.*header/i.test(message)) return 'corrupt_or_truncated_image'
  if (/out of memory|unable to allocate|allocation failed/i.test(message)) return 'memory_allocation_failed'
  return 'unclassified_decoder_error'
}
