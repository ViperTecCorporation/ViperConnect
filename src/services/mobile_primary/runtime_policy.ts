/** Deployment identity, not a laboratory allowlist. Keep it aligned across web and worker. */
export const mobilePrimaryServer = () => process.env.UNOAPI_SERVER_NAME || 'server_1'
export const mobilePrimaryReady = () => /^[a-f0-9]{64}$/i.test(process.env.MOBILE_REGISTRATION_KEY || '')
// The previous delayed queue has immutable dead-letter arguments pointing to a
// shared exchange. A new topology must never redeclare that queue differently.
export const mobileHistoryQueue = () => `unoapi.mobile.companion.history.v2.${mobilePrimaryServer()}.zapo`
