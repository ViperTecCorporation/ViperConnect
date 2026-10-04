'use strict'
// Run in the lab image with --network none. Uses fictitious keys only.
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { registrationModule } = require('./worker.cjs')
const root = '/opt/mobile-registration/node_modules/whalibmob'
const Module = require('node:module')
const originalCompile = Module.prototype._compile
let observed
let api
try {
  Module.prototype._compile = function (source, filename) {
    if (filename === root + '/lib/Registration.js') {
      assert.ok(source.includes('module.__observeRegistration(path, result);'))
      this.__observeRegistration('/register', { status: 'fail', reason: 'test_reason', pending: 'test_pending', login: '999123456789', code: '123456', token: 'SECRET' })
      this.__observeRegistration('/client_log', { reason: 'must_not_replace' })
    }
    return originalCompile.call(this, source, filename)
  }
  api = registrationModule(root, detail => { observed = detail })
} finally { Module.prototype._compile = originalCompile }
assert.deepEqual(observed, { stage: 'verify', reason: 'provider_response', providerStatus: 'fail', providerReason: 'test_reason', providerPending: 'test_pending' })
assert.equal(typeof api.requestSmsCode, 'function')
assert.equal(typeof api.verifyCode, 'function')
assert.equal(require('/opt/mobile-registration/node_modules/protobufjs/package.json').version, '7.6.6')
const child = fork(require.resolve('./worker.cjs'), [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { MOBILE_REGISTRATION_MODULE: root, WA_OS: 'android', WA_BUSINESS: '0' },
})
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 10000)
child.once('message', result => {
  try {
    assert.ok(result.store?.noiseKeyPair?.private)
    assert.equal(result.store.registered, false)
    assert.equal(result.store.phoneNumber, '999123456789')
    console.log('OK: fonte fixada, shim carregado, protobuf corrigido e preparação IPC offline; sem SMS.')
  } catch { process.exitCode = 1 }
})
child.once('exit', code => { clearTimeout(timer); if (code !== 0) process.exitCode = 1 })
child.send({ action: 'prepare', draft: { phone: '999123456789', name: 'Offline' } })
