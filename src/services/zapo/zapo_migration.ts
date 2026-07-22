import type { WaStoreSession } from 'zapo-js'
import { migrate, type LossReportEntry } from 'wa-store-migrate'
import type { BaileysAuthSnapshot } from 'wa-store-migrate/baileys'
import type { ZapoStoreSnapshot } from 'wa-store-migrate/zapo'
import type { Config } from '../config'
import { readBaileysFileSnapshot, readBaileysRedisSnapshot } from './baileys_snapshot'
import { writeZapoSnapshot } from './zapo_snapshot'

export type ZapoMigrationResult = {
  status: 'already-migrated' | 'source-not-found' | 'migrated'
  losses: readonly LossReportEntry[]
}

type MigrationDependencies = {
  readFileSnapshot: typeof readBaileysFileSnapshot
  readRedisSnapshot: typeof readBaileysRedisSnapshot
  convert: (snapshot: BaileysAuthSnapshot) => { data: ZapoStoreSnapshot; losses: readonly LossReportEntry[] }
  write: typeof writeZapoSnapshot
}

const defaultDependencies: MigrationDependencies = {
  readFileSnapshot: readBaileysFileSnapshot,
  readRedisSnapshot: readBaileysRedisSnapshot,
  convert: (snapshot) => migrate({ from: 'baileys', to: 'zapo', data: snapshot, validate: true }),
  write: writeZapoSnapshot,
}

export const migrateBaileysSessionToZapo = async (
  phone: string,
  config: Config,
  store: WaStoreSession,
  dependencies: MigrationDependencies = defaultDependencies,
): Promise<ZapoMigrationResult> => {
  if (await store.auth.load()) return { status: 'already-migrated', losses: [] }
  const source = config.useRedis
    ? await dependencies.readRedisSnapshot(phone)
    : dependencies.readFileSnapshot(phone, config.baseStore)
  if (!source) return { status: 'source-not-found', losses: [] }

  const converted = dependencies.convert(source)
  await dependencies.write(store, converted.data)
  if (!(await store.auth.load())) throw new Error(`Zapo migration validation failed for session ${phone}`)
  return { status: 'migrated', losses: converted.losses }
}

const pendingMigrations = new Map<string, Promise<ZapoMigrationResult>>()

export const ensureZapoSessionMigration = async (
  phone: string,
  config: Config,
  store: WaStoreSession,
  dependencies: MigrationDependencies = defaultDependencies,
): Promise<ZapoMigrationResult> => {
  const current = pendingMigrations.get(phone)
  if (current) return current
  const migration = migrateBaileysSessionToZapo(phone, config, store, dependencies)
  pendingMigrations.set(phone, migration)
  try {
    return await migration
  } finally {
    pendingMigrations.delete(phone)
  }
}
