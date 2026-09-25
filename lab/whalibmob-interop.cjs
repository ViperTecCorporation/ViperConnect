'use strict'

// Offline only. Run from the repository with an audited clone at the pinned commit.
// Never accepts a real account file, opens a WhatsApp client, or writes credentials.
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const root = path.resolve(__dirname, '..')
require('ts-node').register({ project: path.join(root, 'tsconfig.json'), experimentalResolver: true })
const { convertWhalibmobCredentials, WHALIBMOB_CREDENTIAL_SOURCE } = require('../src/services/mobile_primary/whalibmob_credentials.ts')

async function main() {
  assert.ok(process.argv[2], 'Supply an audited whalibmob checkout path')
  const source = path.resolve(process.argv[2])
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
  assert.equal(git('rev-parse', 'HEAD'), WHALIBMOB_CREDENTIAL_SOURCE, 'Unexpected source revision')
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Source must be clean')
  // Reuse installed development dependencies only within this disposable process.
  process.env.NODE_PATH = path.join(root, 'node_modules')
  require('node:module').Module._initPaths()
  const { createNewStore, storeToJson } = require(path.join(source, 'lib/Store.js'))
  const { WaAuthMemoryStore } = require('zapo-js/store')
  for (const os of ['android', 'ios']) {
    for (const business of ['0', '1']) {
      process.env.WA_OS = os
      process.env.WA_BUSINESS = business
      delete process.env.WA_DEVICE
      const store = createNewStore('999123456789', { name: 'Offline fixture' })
      // Synthetic registration flag ONLY for this offline fixture, not a server claim.
      store.registered = true
      const opts = { expectedCanonicalPhone: store.phoneNumber, advSecretKey: randomBytes(32) }
      const converted = await convertWhalibmobCredentials(store, opts)
      assert.deepEqual(await convertWhalibmobCredentials(storeToJson(store), opts), converted)
      const auth = new WaAuthMemoryStore()
      await auth.save(converted)
      assert.deepEqual(await auth.load(), converted)
      assert.equal(converted.deviceInfo.os, os)
      assert.equal(converted.deviceInfo.business, business === '1')
      console.log(`OK offline: ${os}/${business === '1' ? 'business' : 'personal'}; upstream key generation, JSON conversion and Zapo memory auth store`)
    }
  }
}
main().catch(() => { console.error('Offline interoperability check failed; no credential data printed.'); process.exitCode = 1 })
