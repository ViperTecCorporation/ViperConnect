/** Private versioned snapshots belong to the session, never their Redis locks. */
export function privateSessionKeyOwner(key: unknown): string | undefined {
  if (typeof key !== 'string' || key.length > 1024) return undefined
  const match = /^unoapi-(own-profile|own-privacy|own-profile-cover):v1:([1-9]\d{7,14})(?::(generation))?$/.exec(key)
  return match && !(match[1] === 'own-profile-cover' && match[3]) ? match[2] : undefined
}
