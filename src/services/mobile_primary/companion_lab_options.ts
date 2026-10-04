/** Experimental SDK option: opt-in in the isolated lab only. */
export function companionLabOptions(env: NodeJS.ProcessEnv = process.env): { includePem?: true } {
  return env.UNOAPI_MOBILE_PRIMARY_LAB === 'true' && env.UNOAPI_MOBILE_COMPANION_PEM_LAB === 'true'
    ? { includePem: true }
    : {}
}
