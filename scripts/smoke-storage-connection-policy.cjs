/* DEV only: unknown synthetic phone, HTTP rejection before RPC/socket creation. */
const { createRequire } = require('node:module')
const { randomInt } = require('node:crypto')
const assert = require('node:assert/strict')
const app = createRequire('/app/package.json')

async function main() {
  if (process.env.STORAGE_POLICY_CONFIRM !== 'synthetic-lab-only' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab'
    || process.env.REDIS_URL !== 'redis://redis:6379') throw Error('isolated_lab_confirmation_required')
  const redis = new (app('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  redis.on('error', () => {})
  const phone = '999011' + randomInt(1000000, 9999999)
  const configKey = `unoapi-config:${phone}`, leaseKey = `unoapi-lease:zapo-session:${phone}`
  let businessId, verified = false, stage = 'empty-phone', signature
  try {
    assert.equal(await redis.exists(configKey, leaseKey), 0, 'synthetic_phone_not_empty')
    stage = 'resolve-config'
    const { getConfigRedis } = app('/app/dist/src/services/config_redis.js')
    businessId = (await getConfigRedis(phone)).webhookForward?.businessAccountId
    for (const [path, method] of [[`/connect/${phone}`, 'GET'], [`/sessions/${phone}`, 'GET'], [`/${phone}/request_code`, 'POST']]) {
      stage = path.startsWith('/connect') ? 'connect' : path.startsWith('/sessions') ? 'sessions' : 'pairing'
      const response = await fetch('http://web:9876' + path, { method, headers: { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN }, signal: AbortSignal.timeout(10000) })
      assert.equal(response.status, 409, 'connection_policy_http_status')
      const body = await response.json()
      signature = { keys: Object.keys(body), errorType: typeof body.error, errorKeys: body.error && typeof body.error === 'object' ? Object.keys(body.error) : undefined }
      assert.equal(body.error_code || body.error || body.message, 'session_storage_registration_required')
    }
    assert.equal(await redis.exists(configKey, leaseKey), 0, 'implicit_config_or_socket_created')
    verified = true
    console.log(JSON.stringify({ connectionPolicyHttp: 3, registrationRequired: true, implicitSessionCreated: false, realSends: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ connectionPolicyStage: stage, error: error.code || error.name,
      actualStatus: typeof error.actual === 'number' ? error.actual : undefined, signature }))
    throw error
  } finally {
    // Only remove this test's synthetic alias; never delete configuration/data.
    if (businessId) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('UNLINK',KEYS[1]) end return 0", 1,
      `unoapi-meta:business_account_id:${businessId}`, phone)
    await redis.quit()
    console.log(JSON.stringify({ connectionPolicyCleanup: true, verified }))
  }
}
main().then(() => process.exit(0)).catch(() => { console.error('connection_policy_smoke_failed'); process.exit(1) })
