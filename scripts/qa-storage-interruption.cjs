// Real process death and Redis CAS; shortened leases/stale age only in a disposable fixture.
const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{fork}=require('node:child_process')
const {randomUUID}=require('node:crypto'),fs=require('node:fs/promises'),{join,resolve,sep}=require('node:path')
const a=createRequire('/app/package.json'),phone='9990161111111',owner='dr-isolated',url='redis://viperconnect-dr-qa-20261110:6379/2'
async function main(){
  assert.equal(process.env.QA_INTERRUPTION_CONFIRM,'disposable-lab-only');assert.equal(process.env.UNOAPI_SERVER_NAME,'mobile_lab')
  const {createClient}=a('@redis/client'),redis=createClient({url});redis.on('error',()=>{});await redis.connect()
  const {SessionStorageCatalog}=a('/app/dist/src/services/session_storage/catalog.js'),{restorePreparedSession}=a('/app/dist/src/services/session_storage/recovery.js')
  const {openSessionDatabase,openPreparedSessionDatabase,closeAllSessionDatabases}=a('/app/dist/src/services/session_storage/database.js')
  const config=async()=>JSON.parse(await redis.get('unoapi-config:'+phone))
  const lease=()=>{const key='unoapi-lease:zapo-session:'+phone,token=randomUUID();return{ownership:()=>({key,token}),acquire:async()=>await redis.set(key,token,{NX:true,PX:2000})==='OK',
    assertOwned:async()=>{assert.equal(await redis.get(key),token);await redis.pExpire(key,2000)},release:async()=>{if(await redis.get(key)===token)await redis.del(key)}}}
  const root=process.env.QA_INTERRUPTION_ROOT||await fs.mkdtemp('/tmp/viper-interruption-')
  const hooks=(crash,taskId)=>({owner,getConfig:async()=>({...await config(),baseStore:root}),isOffline:async()=>true,sourceIsEmpty:async()=>false,
    acquireLease:async()=>{const l=lease();assert.equal(await l.acquire(),true);return l},
    restoreArchive:async(_p,_id,path)=>{
      if(crash){await fs.writeFile(path,'incomplete-download');const key='unoapi-session-storage:task:'+phone+':'+taskId,t=JSON.parse(await redis.get(key));t.updatedAt=Date.now()-601000;await redis.set(key,JSON.stringify(t));await redis.pExpire('unoapi-session-storage:task:lock:'+phone,2000);process.send({partialFileWritten:true});await new Promise(()=>{})}
      await fs.copyFile(join(root,'backup.sqlite'),path);return{manifest:{phone,id:_id,status:'ready'},supplement:{}}
    },validate:async(_p,path)=>{const db=openPreparedSessionDatabase(path);try{return{identity:db.get('SELECT value FROM uno_storage_meta WHERE key=?',['phone']).value===phone,ids:db.get('PRAGMA quick_check').quick_check==='ok'}}finally{db.close()}}})
  try{
    if(process.env.QA_INTERRUPTION_CHILD==='true'){
      const {SessionStorageTasks}=a('/app/dist/src/services/session_storage/tasks.js')
      await new SessionStorageTasks(redis).start(phone,'restore',async(id,progress)=>restorePreparedSession(new SessionStorageCatalog(redis),hooks(true,id),phone,{backupId:randomUUID(),confirm:true,mode:'offline'},id,progress))
      return await new Promise(()=>{})
    }
    assert.equal(await redis.dbSize(),0)
    const initial={provider:'zapo',server:owner,autoConnect:false,sessionStorage:{backend:'sqlite',storageId:randomUUID(),owner,generation:1,state:'offline',fixture:true}}
    await redis.set('unoapi-config:'+phone,JSON.stringify(initial))
    const db=openSessionDatabase(phone,{...initial,baseStore:root},{create:true});db.putValue('fixture-marker','original-preserved');await db.backup(join(root,'backup.sqlite'));closeAllSessionDatabases()
    const child=fork('/app/scripts/qa-storage-interruption.cjs',[],{env:{...process.env,QA_INTERRUPTION_CHILD:'true',QA_INTERRUPTION_ROOT:root},stdio:['ignore','ignore','pipe','ipc']})
    try{
      await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('fixture_never_reached_restore')),15000);child.once('message',m=>{clearTimeout(timer);m.partialFileWritten?ok():no(Error('unexpected_phase'))});child.once('error',no)})
      const ended=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal})));child.kill('SIGKILL');assert.equal((await ended).signal,'SIGKILL')
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
    await new Promise(r=>setTimeout(r,2300))
    const {reconcileInterruptedStorage}=a('/app/dist/src/services/session_storage/reconciliation.js')
    const result=await reconcileInterruptedStorage(phone,{owner,redis,loadConfig:async()=>({...await config(),baseStore:root}),hasClient:()=>false,lease:()=>lease()})
    assert.equal(result.status,'repaired');assert.equal(result.action,'retry_restore')
    const old=await config();assert.equal(old.sessionStorage.storageId,initial.sessionStorage.storageId);assert.equal(old.autoConnect,false)
    const after=openSessionDatabase(phone,{...old,baseStore:root});assert.equal(after.getValue('fixture-marker').toString(),'original-preserved');closeAllSessionDatabases()
    const restored=await restorePreparedSession(new SessionStorageCatalog(redis),hooks(false),phone,{backupId:randomUUID(),confirm:true,mode:'offline'})
    assert.equal(restored.restored,true);assert.equal(restored.autoConnect,false)
    const done=openSessionDatabase(phone,{...await config(),baseStore:root});assert.equal(done.getValue('fixture-marker').toString(),'original-preserved')
    console.log(JSON.stringify({workerKilledDuringRestore:true,partialNotPromoted:true,originalDatabasePreserved:true,reconciledOffline:true,explicitRetrySucceeded:true,noConnectOrReplay:true,shortenedFixtureLeases:true}))
  }finally{closeAllSessionDatabases();if(process.env.QA_INTERRUPTION_CHILD!=='true'){await redis.flushDb();const p=await fs.realpath(root);assert.ok(p.startsWith('/tmp'+sep+'viper-interruption-'));assert.equal(p,resolve(root));await fs.rm(p,{recursive:true,force:true});console.log(JSON.stringify({interruptionFixtureCleaned:true}))}await redis.quit()}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
