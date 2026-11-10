import type { Config } from './config'

/** Compare persisted intent, not newly bound runtime functions. Keep every
 * serializable option: excluding a proxy/storage/provider option could lose a
 * real change. Cosmetic changes may conservatively request another reload. */
export const sessionReloadIntent = (config: Config): unknown => JSON.parse(JSON.stringify(config))
