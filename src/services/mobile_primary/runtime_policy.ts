/** Deployment identity, not a laboratory allowlist. Keep it aligned across web and worker. */
export const mobilePrimaryServer = () => process.env.UNOAPI_SERVER_NAME || 'server_1'
export const mobilePrimaryReady = () => /^[a-f0-9]{64}$/i.test(process.env.MOBILE_REGISTRATION_KEY || '')
export const mobileHistoryQueue = () => `unoapi.mobile.companion.history.${mobilePrimaryServer()}.zapo`
