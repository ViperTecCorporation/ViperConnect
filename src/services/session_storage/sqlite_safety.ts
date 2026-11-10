/** Fail before enabling WAL on engines older than the upstream WAL-reset fix.
 * Uses the actual connection's sqlite_version(), never an npm package version. */
export function assertSqliteWalSafeVersion(version: unknown): void {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error('session_storage_sqlite_version_unsupported')
  const [, major, minor, patch] = match.map(Number)
  if (major < 3 || major === 3 && (minor < 51 || minor === 51 && patch < 3)) throw new Error('session_storage_sqlite_version_unsupported')
}
