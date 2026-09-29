import { profileImageFailureReason } from '../../src/services/profile_image_diagnostic'

test.each([
  ['Input image exceeds pixel limit', 'pixel_limit_exceeded'],
  ['Input buffer contains unsupported image format', 'unsupported_image_format'],
  ['heif: No decoding plugin installed', 'decoder_unavailable'],
  ['jpeg: premature end of input', 'corrupt_or_truncated_image'],
  ['out of memory', 'memory_allocation_failed'],
  ['PRIVATE https://example.com/?token=SECRET', 'unclassified_decoder_error'],
])('classifies decoder failure without copying native text: %s', (message, reason) => {
  expect(profileImageFailureReason(new Error(message))).toBe(reason)
})

test('non-error values are never serialized', () => {
  expect(profileImageFailureReason({ secret: 'SECRET' })).toBe('unclassified_decoder_error')
})
