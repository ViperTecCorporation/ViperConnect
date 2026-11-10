// Run only in the DEV VoIP container. Private baseline stays in its data volume.
const assert = require('node:assert/strict'), fs = require('node:fs')
const { createHash } = require('node:crypto'), { resolve } = require('node:path')
const statePath = '/home/u/app/data/qa-restore-voip-20261110.json'
async function main() {
  assert.equal(process.env.QA_VOIP_RESTORE_CONFIRM, 'authorized-mobile-lab')
  assert.equal(process.env.VOIP_LAN_DOMAIN, '127.0.0.1')
  assert.equal(process.env.VOIP_SQLITE_PATH, '/home/u/app/data/voip.sqlite')
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(process.env.VOIP_SQLITE_PATH, { readOnly: true })
  const headers = { Authorization: 'Bearer ' + process.env.VOIP_SERVICE_TOKEN }
  const request = async (path, body) => {
    const r = await fetch('http://127.0.0.1:3097' + path, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'PUT', body: JSON.stringify(body) } : {}) }); assert.equal(r.status,200);return r.json()
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const measure = () => {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok')
    const config = JSON.parse(db.prepare("SELECT value_json FROM app_kv WHERE key='voice_config'").get().value_json)
    const tables = Object.fromEntries(['call_history','call_recordings','call_ai_summaries'].map(t => {
      const rows=db.prepare('SELECT * FROM '+t).all().map(row=>JSON.stringify(row)).sort();return [t,{count:rows.length,digest:hash(JSON.stringify(rows))}]
    }))
    const audio=config.extensionGroups.filter(g=>g.transferAudioSource).map(g=>{
      const p=resolve(g.transferAudioSource);assert.ok(p.startsWith('/home/u/app/data/transfer-audio/'));return {id:g.id,hash:hash(fs.readFileSync(p))}
    })
    return {config,tables,audio}
  }
  try {
    assert.equal((await request('/v1/zapo/calls')).calls.length,0)
    const b=await request('/v1/console/bootstrap');assert.equal(b.router.locks.length,0)
    if(process.env.QA_VOIP_RESTORE_PHASE==='before') {
      assert.equal(fs.existsSync(statePath),false)
      const state=measure();fs.writeFileSync(statePath,JSON.stringify(state),{mode:0o600,flag:'wx'})
      console.log(JSON.stringify({voipBaselineCaptured:true,tables:state.tables,audioFiles:state.audio.length,companies:state.config.companies.length,extensions:state.config.extensions.length}));return
    }
    const state=JSON.parse(fs.readFileSync(statePath)),actual=measure()
    assert.deepEqual(actual.tables,state.tables)
    assert.deepEqual(actual.audio,state.audio)
    for(const key of ['sip','accounts','extensions','sessions','lineGroups'])assert.deepEqual(actual.config[key],state.config[key],key+'_changed')
    for(const c of actual.config.companies)if(c.viperchatWebhook)assert.equal(c.viperchatWebhook.enabled,false)
    const capability=await request('/v1/console/backups/capability');assert.equal(capability.lastRestore.restored,true)
    let reenabled=0
    for(const company of state.config.companies)if(company.viperchatWebhook?.enabled){
      await request('/v1/console/companies/'+encodeURIComponent(company.id),company);reenabled++
    }
    console.log(JSON.stringify({realVoipRestored:true,tablesIdentical:true,holdAudioHashesIdentical:true,sipAddressesPreserved:true,webhooksDisabledVerified:true,originalLabWebhooksReenabled:reenabled,receiptConfirmed:true}))
  } finally { db.close() }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
