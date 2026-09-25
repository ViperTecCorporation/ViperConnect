'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Module = require('node:module')
const { failure, responseDiagnostic } = require('./diagnostic.cjs')

// Pinned-source compatibility shim: limit /code to one attempt and never switch
// delivery methods. No challenge bypass, credential extraction or TLS weakening.
function registrationModule(root, observe = () => {}) {
  const filename = path.join(root, 'lib/Registration.js')
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  if (crypto.createHash('sha256').update(source).digest('hex') !== 'be7b4d0737550c0270ac4c1d834a0c13143444aa5e006e8e4694bad359b5f71c') throw new Error('source_mismatch')
  source = source.replace('const MAX_CODE_REQUEST_ATTEMPTS = 5;', 'const MAX_CODE_REQUEST_ATTEMPTS = 1;')
    .replace("if (result && result._noRoutes && !autoFallbackDone && method !== 'email')", 'if (false)')
  const responseLine = 'const result = await httpPost(path, body, waVersion, bodyAtt.authorizationHeader, device);'
  if (source.split(responseLine).length !== 2) throw new Error('source_mismatch')
  source = source.replace(responseLine, responseLine + '\n  module.__observeRegistration(path, result);')
  const mod = new Module(filename, module)
  mod.__observeRegistration = (endpoint, result) => {
    if (endpoint === '/code' || endpoint === '/register') {
      observe(responseDiagnostic(result, endpoint === '/code' ? 'request' : 'verify'))
    }
  }
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod._compile(source, filename)
  return mod.exports
}

async function operate(input, dependencies) {
  const root = process.env.MOBILE_REGISTRATION_MODULE
  if (!root || !path.isAbsolute(root)) throw new Error('module_required')
  const { createNewStore, storeFromJson, storeToJson } = dependencies?.store || require(path.join(root, 'lib/Store.js'))
  if (input.action === 'prepare') return { store: storeToJson(createNewStore(input.draft.phone, { name: input.draft.name })) }
  const store = storeFromJson(input.store)
  let observed
  const registration = dependencies?.registration || registrationModule(root, detail => { observed = detail })
  try {
    if (input.action === 'request') {
      const result = await registration.requestSmsCode(store, 'sms')
      if (!['ok', 'sent'].includes(result?.status)) return { error: 'provider_failed', diagnostic: observed || responseDiagnostic(result, input.action) }
      store.codePending = true
      return { store: storeToJson(store), diagnostic: observed || responseDiagnostic(result, input.action) }
    } else if (input.action === 'verify') {
      const result = await registration.verifyCode(store, input.code)
      // Never treat "sent", a pending challenge, or a local flag as registered.
      if (!['ok', 'verified'].includes(result?.status) || result.pending || !/^[1-9]\d{7,14}$/.test(String(result.login || ''))) return { error: 'challenge_required', diagnostic: observed || responseDiagnostic(result, input.action) }
      store.phoneNumber = String(result.login); store.registered = true; store.codePending = false
    } else throw new Error('invalid_action')
    return { store: storeToJson(store) }
  } catch (error) {
    const result = failure(error, input.action)
    const detail = observed || (error?.raw ? responseDiagnostic(error.raw, input.action) : undefined)
    if (detail) result.diagnostic = { ...detail, ...result.diagnostic, reason: result.diagnostic.reason === 'unknown' ? detail.reason : result.diagnostic.reason }
    return result
  }
}

if (require.main === module) {
  process.once('disconnect', () => process.exit(1))
  setTimeout(() => process.exit(1), 90000).unref()
  process.once('message', async input => {
  let result
  try { result = await operate(input) } catch (error) { result = failure(error, input.action) }
  process.send(result, () => process.exit(0))
  })
}
module.exports = { registrationModule, operate }
