import { mobilePrimaryReady, mobilePrimaryServer, mobileHistoryQueue } from '../../src/services/mobile_primary/runtime_policy'
import { readFileSync } from 'node:fs'
const before = { ...process.env }
afterEach(() => { process.env = { ...before } })
test.each(['server_1', 'production_east', 'worker-02', 'mobile_lab'])('supports %s without lab flags and isolates queue and exchange', server => {
  delete process.env.UNOAPI_MOBILE_PRIMARY_LAB
  delete process.env.MOBILE_REGISTRATION_ENABLED
  process.env.UNOAPI_SERVER_NAME = server
  process.env.MOBILE_REGISTRATION_KEY = 'ab'.repeat(32)
  expect(mobilePrimaryReady()).toBe(true)
  expect(mobilePrimaryServer()).toBe(server)
  expect(mobileHistoryQueue()).toBe(`unoapi.mobile.companion.history.v2.${server}.zapo`)
  expect(mobileHistoryQueue()).not.toBe(`unoapi.mobile.companion.history.${server}.zapo`)
  expect(readFileSync('src/services/mobile_primary/companion_history_runtime.ts', 'utf8')).toContain('const EXCHANGE = COMPANION_HISTORY_QUEUE')
})
test('defaults to server_1 and still requires a valid encryption key', () => {
  delete process.env.UNOAPI_SERVER_NAME; delete process.env.MOBILE_REGISTRATION_KEY
  expect(mobilePrimaryServer()).toBe('server_1'); expect(mobilePrimaryReady()).toBe(false)
  process.env.MOBILE_REGISTRATION_KEY = 'short'; expect(mobilePrimaryReady()).toBe(false)
})
test('production image installs and validates the same pinned mobile package as CI', () => {
  const docker = readFileSync('Dockerfile', 'utf8')
  expect(docker).toContain('npm ci --prefix lab/registration --omit=dev --ignore-scripts')
  expect(docker).toContain('COPY --from=mobile-registration /app/lab/registration/node_modules /opt/mobile-registration/node_modules')
  expect(docker).toContain('RUN node scripts/check-mobile-runtime.cjs')
  expect(readFileSync('.github/workflows/main.yml', 'utf8')).toContain('yarn check:mobile-runtime')
})
