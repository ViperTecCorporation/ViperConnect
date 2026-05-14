import { GroupMetadata } from '@whiskeysockets/baileys'

const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0

export const mergeGroupMetadataForCache = (
  previous: GroupMetadata | undefined,
  next: GroupMetadata,
): GroupMetadata => {
  if (!previous) return next

  const merged = {
    ...previous,
    ...next,
  } as GroupMetadata

  if (!hasText((next as any).subject) && hasText((previous as any).subject)) {
    const writable = merged as any
    writable.subject = (previous as any).subject
  }

  if (!hasText((next as any).profilePicture) && hasText((previous as any).profilePicture)) {
    const writable = merged as any
    writable.profilePicture = (previous as any).profilePicture
  }

  if (!Array.isArray((next as any).participants) && Array.isArray((previous as any).participants)) {
    const writable = merged as any
    writable.participants = (previous as any).participants
  }

  return merged
}
