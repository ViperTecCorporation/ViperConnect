// Starts the actual worker executable without contacting WhatsApp or making a call.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const binary = process.env.ZAPO_VOIP_RELAY_BRIDGE_PATH
assert.ok(binary, 'O worker não configurou ZAPO_VOIP_RELAY_BRIDGE_PATH')
const result = spawnSync(binary, ['-h'], { encoding: 'utf8', timeout: 5000 })
assert.ifError(result.error)
assert.equal(result.status, 0, 'O executável relay-bridge não iniciou corretamente')
assert.match(result.stderr + result.stdout, /relay UDP port/)
console.log('Worker: relay-bridge executável e inicialização validada, sem chamada.')
