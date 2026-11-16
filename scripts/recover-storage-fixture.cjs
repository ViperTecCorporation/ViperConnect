/* Explicit recovery of an interrupted DEV fixture only; leaves all source/staging data intact. */
async function main() {
  if (process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') throw new Error('isolated_lab_required')
  const phone = process.env.STORAGE_FIXTURE_PHONE, task = process.env.STORAGE_FIXTURE_INTERRUPTED_TASK
  if (!/^\d{8,15}$/.test(phone || '') || !/^[a-f0-9-]{36}$/.test(task || '')) throw new Error('invalid_fixture_recovery')
  const Redis = require('ioredis'), r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  try {
    const n = await r.eval(`
      local raw=redis.call('GET',KEYS[1]);if not raw then return 0 end
      local cfg=cjson.decode(raw);local s=cfg.sessionStorage
      if not s or s.fixture~=true or s.backend~='redis' or s.state~='migrating' or cfg.autoConnect~=false or cfg.sessionStorageTaskId~=ARGV[1] then return 0 end
      if redis.call('EXISTS',KEYS[2])==1 or redis.call('EXISTS',KEYS[3])==1 then return 0 end
      s.state='offline';s.generation=s.generation+1;cfg.sessionStorageTaskId=nil
      redis.call('SET',KEYS[1],cjson.encode(cfg));redis.call('PUBLISH','unoapi-config:update',ARGV[2])
      local old=redis.call('GET',KEYS[4]);if old then local t=cjson.decode(old);t.status='interrupted';t.error='dev_worker_hot_reload_interrupted';redis.call('SET',KEYS[4],cjson.encode(t),'EX',604800) end
      return s.generation`, 4, `unoapi-config:${phone}`, `unoapi-lease:zapo-session:${phone}`, `unoapi-session-storage:task:lock:${phone}`, `unoapi-session-storage:task:${phone}:${task}`, task, phone)
    if (!n) throw new Error('fixture_recovery_guard_refused')
    console.log(JSON.stringify({ recoveredFixture: phone, generation: n, sourcePreserved: true, partialFilePreserved: true, realSends: 0 }))
  } finally { await r.quit() }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1) })
