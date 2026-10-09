const path = require('node:path')
const fs = require('node:fs')
const root = process.env.MOBILE_REGISTRATION_MODULE || path.resolve('lab/registration/node_modules/whalibmob')
const { registrationModule } = require('../lab/registration/worker.cjs')
const store = require(path.join(root, 'lib/Store.js'))
const registration = registrationModule(root)
for (const name of ['createNewStore', 'storeFromJson', 'storeToJson']) {
  if (typeof store[name] !== 'function') throw new Error('mobile_store_contract_missing: ' + name)
}
for (const name of ['requestSmsCode', 'verifyCode', 'checkIfRegistered']) {
  if (typeof registration[name] !== 'function') throw new Error('mobile_registration_contract_missing: ' + name)
}
const lock = JSON.parse(fs.readFileSync(path.resolve('lab/registration/package-lock.json'), 'utf8'))
if (!lock.packages[''].dependencies.whalibmob.endsWith('#8d16ce663664425611944a07e083b8553985fd08')) throw new Error('mobile_registration_unpinned')
console.log('Mobile registration runtime and pinned source validated; no SMS or network request sent.')
