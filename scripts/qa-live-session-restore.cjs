// Explicitly authorized DEV restore rehearsal. Never logout, unregister or contact another number.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { readFile, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { resolve } = require('node:path')
const a = createRequire('/app/package.json'), phone = '5566996269251'
const statePath = '/app/session-data/qa-restore-5566996269251-20261110.json'
async function main() {
  assert.equal(process.env.QA_LIVE_RESTORE_CONFIRM, 'authorized-dev-5566996269251')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
  assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
  assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
  assert.notEqual(process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY, 'true')
  const redis = new (a('ioredis'))(process.env.REDIS_URL)
  const phase = process.env.QA_LIVE_RESTORE_PHASE
  const headers = { Authorization: 'Bearer ' + process.env.UNOAPI_AUTH_TOKEN }
  const getConfig = async () => JSON.parse(await redis.get('unoapi-config:' + phone) || 'null')
  const request = async (path, body, expected = 200) => {
    const r = await fetch('http://web:9876' + path, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    assert.equal(r.status, expected, 'live_restore_http_' + r.status); return r.json()
  }
  const wait = async (test, code) => { for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise(r => setTimeout(r,500)) } throw Error(code) }
  const measure = c => {
    const { DatabaseSync } = a('node:sqlite'), db = new DatabaseSync(resolve(process.env.SESSION_STORAGE_ROOT, 'session-storage', c.sessionStorage.storageId, 'session.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      const ids = a('/app/dist/src/services/session_storage/id_validation.js')
      assert.equal(ids.validateLiveIdMappings({ get: (sql,args) => db.prepare(sql).get(...args) },phone),true)
      const rows = db.prepare('SELECT message_id,hex(message_bytes) bytes FROM mailbox_messages WHERE session_id=? ORDER BY message_id').all(phone)
      return { messages: rows.length, messageDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        idPairs: Number(db.prepare("SELECT COUNT(*) n FROM uno_kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at>?)").get('unoapi-id:'+phone+':%',Date.now()).n) }
    } finally { db.close() }
  }
  let state = JSON.parse(await readFile(statePath,'utf8').catch(()=>'null'))
  const save = () => writeFile(statePath,JSON.stringify(state),{mode:0o600})
  try {
    let c = await getConfig()
    assert.equal(c.provider,'zapo');assert.equal(c.server,'mobile_lab');assert.equal(c.sessionStorage.backend,'sqlite');assert.ok(!c.sessionStorage.fixture);assert.ok(!c.mobilePrimaryDraftId)
    const { VoipService } = a('/app/dist/src/services/voip_service.js')
    const voice = new VoipService(), calls = await voice.request('/v1/zapo/calls?session='+phone)
    assert.equal(calls.calls.length,0,'live_restore_active_call')
    if (phase==='inspect') {
      console.log(JSON.stringify({phone,status:await redis.get('unoapi-status:'+phone),backend:'sqlite',generation:c.sessionStorage.generation,
        webhookHosts:(c.webhooks||[]).filter(h=>h.enabled!==false&&(h.urlAbsolute||h.url)).map(h=>new URL(h.urlAbsolute||h.url).hostname),baseline:measure(c),previousRehearsal:!!state}));return
    }
    if (phase==='pause-backup') {
      assert.equal(state,null,'existing_rehearsal_requires_review');assert.equal(await redis.get('unoapi-status:'+phone),'online')
      state={phone,previousAutoConnect:c.autoConnect,originalStorage:c.sessionStorage,phase:'pausing',startedAt:Date.now()};await save()
      await request('/v15.0/'+phone+'/register',{autoConnect:false})
      await wait(async()=>await redis.get('unoapi-status:'+phone)==='offline'&&!await redis.exists('unoapi-lease:zapo-session:'+phone),'offline_not_confirmed')
      c=await getConfig();assert.equal(c.autoConnect,false);state.baseline=measure(c);state.phase='paused';await save()
      const task=await request('/v15.0/'+phone+'/storage/backups',{confirm:true},202);state.backupTaskId=task.id;await save()
      let receipt
      await wait(async()=>{receipt=await request('/v15.0/'+phone+'/storage/tasks/'+task.id);if(receipt.status==='failed')throw Error(receipt.error);return receipt.status==='ready'},'backup_not_confirmed')
      state.backup=receipt.result;state.phase='backup-ready';await save()
      console.log(JSON.stringify({pausedWithoutLogout:true,backupReady:true,backupId:state.backup.id,bytes:state.backup.bytes,baseline:state.baseline}));return
    }
    assert.equal(state.phone,phone)
    if (phase==='verify-reconnect') {
      assert.equal(c.autoConnect,false);assert.equal(await redis.get('unoapi-status:'+phone),'offline')
      assert.notEqual(c.sessionStorage.storageId,state.originalStorage.storageId,'restore_not_applied')
      const actual=measure(c);assert.equal(actual.messages,state.baseline.messages);assert.equal(actual.messageDigest,state.baseline.messageDigest);assert.equal(actual.idPairs,state.baseline.idPairs)
      state.restoredStorage=c.sessionStorage;state.phase='restore-verified';await save()
      await request('/v15.0/'+phone+'/register',{autoConnect:state.previousAutoConnect})
      await wait(async()=>await redis.get('unoapi-status:'+phone)==='online'&&!!await redis.exists('unoapi-lease:zapo-session:'+phone),'reconnection_not_confirmed')
      state.phase='online-after-restore';state.finishedAt=Date.now();await save()
      console.log(JSON.stringify({realSessionRestored:true,baselinePreserved:true,onlineWithLease:true,newQrRequired:false,storageGeneration:c.sessionStorage.generation,measure:actual}));return
    }
    if (phase==='resume-without-restore') {
      assert.ok(['pausing','paused','backup-ready'].includes(state.phase));assert.equal(c.sessionStorage.storageId,state.originalStorage.storageId)
      await request('/v15.0/'+phone+'/register',{autoConnect:state.previousAutoConnect});await wait(async()=>await redis.get('unoapi-status:'+phone)==='online','resume_not_confirmed')
      state.phase='resumed-original';await save();console.log(JSON.stringify({originalResumed:true}));return
    }
    throw Error('unknown_phase')
  } finally { await redis.quit() }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
