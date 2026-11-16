// Real S3 archives, disposable Redis, no WhatsApp runtime or restored socket.
const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto')
const fs=require('node:fs/promises'),{join,resolve,sep}=require('node:path'),a=createRequire('/app/package.json')
const directory='/tmp/viper-dr-full-20261110',instance='qa-dr-full-20261110',statePath=directory+'/state.json'
async function main(){
  assert.equal(process.env.QA_DR_CONFIRM,'isolated-mobile-lab');assert.equal(process.env.UNOAPI_SERVER_NAME,'mobile_lab');assert.equal(process.env.REDIS_URL,'redis://redis:6379')
  const {createBackupObjects}=a('/app/dist/src/services/session_storage/backup_objects.js'),objects=createBackupObjects()
  const {RedisGlobalBackups}=a('/app/dist/src/services/session_storage/redis_backup.js'),index=new Map()
  const service=new RedisGlobalBackups(objects,{put:async m=>index.set(m.id,m),get:async id=>index.get(id)})
  const Redis=a('ioredis'),source=new Redis(process.env.REDIS_URL)
  try{
    if(process.env.QA_DR_PHASE==='prepare'){
      await fs.mkdir(directory,{mode:0o700})
      const configurations={};for(const phone of ['5566996269251','5566936183915'])configurations[phone]=await source.get('unoapi-config:'+phone)
      const manifest=await service.backup({enabled:true,confirmAllDatabases:true,cliPath:'/usr/bin/redis-cli',redisUrl:process.env.REDIS_URL,instanceId:instance})
      await fs.writeFile(statePath,JSON.stringify({manifest,configurations}),{mode:0o600})
      await service.prepareRestore({instanceId:instance,backupId:manifest.id,destination:directory+'/dump.rdb',confirmOffline:true,isDestinationOffline:async()=>true})
      console.log(JSON.stringify({redisRdbReady:true,id:manifest.id,bytes:manifest.bytes,readbackVerified:manifest.uploadVerified}));return
    }
    const state=JSON.parse(await fs.readFile(statePath,'utf8')),target=new Redis('redis://viperconnect-dr-qa-20261110:6379/0')
    try{
      if(process.env.QA_DR_PHASE==='verify'){
        for(const [phone,raw]of Object.entries(state.configurations))assert.equal(await target.get('unoapi-config:'+phone),raw)
        assert.ok(await target.dbsize()>0)
        const {createClient}=a('@redis/client'),control=createClient({url:'redis://viperconnect-dr-qa-20261110:6379/1'});control.on('error',()=>{});await control.connect();assert.equal(await control.dbSize(),0)
        try{
          const {restoreStandaloneSession}=a('/app/dist/src/services/session_storage/standalone_recovery.js')
          for(const phone of ['5566996269251','5566936183915']){
            const output=join(directory,'sqlite-'+phone);await fs.mkdir(output,{mode:0o700})
            const restored=await restoreStandaloneSession({phone,weekday:2,confirm:true,confirmOriginOffline:true},{objects,redis:control,baseStore:output,owner:'dr-isolated',registrationKey:process.env.MOBILE_REGISTRATION_KEY,
              destinationEmpty:async p=>!await control.get('unoapi-config:'+p),lease:p=>{
                const key='unoapi-lease:zapo-session:'+p,token=randomUUID();return{ownership:()=>({key,token}),acquire:async()=>await control.set(key,token,{NX:true,PX:120000})==='OK',
                  assertOwned:async()=>{assert.equal(await control.get(key),token);await control.pExpire(key,120000)},release:async()=>{if(await control.get(key)===token)return control.del(key)}}
              }})
            assert.equal(restored.connected,false);assert.equal(restored.autoConnect,false);assert.equal(restored.replayed,false)
            const c=JSON.parse(await control.get('unoapi-config:'+phone));assert.equal(c.sessionStorage.owner,'dr-isolated');assert.equal(c.autoConnect,false)
            const {DatabaseSync}=a('node:sqlite'),db=new DatabaseSync(join(output,'session-storage',c.sessionStorage.storageId,'session.sqlite'),{readOnly:true})
            try{assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(a('/app/dist/src/services/session_storage/id_validation.js').validateLiveIdMappings({get:(s,p)=>db.prepare(s).get(...p)},phone),true)
              console.log(JSON.stringify({phone,restoredWithoutOldCatalogue:true,sqliteIntegrity:true,messages:db.prepare('SELECT COUNT(*) n FROM mailbox_messages WHERE session_id=?').get(phone).n,mobilePrimary:!!c.mobilePrimaryDraftId,offline:true,noConnectOrReplay:true}))
            }finally{db.close()}
          }
        }finally{await control.quit()}
        console.log(JSON.stringify({globalRedisRestored:true,globalConfigurationPreserved:true,redisKeys:await target.dbsize(),isolated:true}));return
      }
      if(process.env.QA_DR_PHASE==='cleanup'){
        for await(const key of objects.keys('backups/redis/'+instance+'/'))await objects.remove(key)
        const path=await fs.realpath(directory);assert.equal(path,resolve(directory));assert.ok(path.startsWith('/tmp'+sep+'viper-dr-full-'));await fs.rm(path,{recursive:true,force:true});console.log(JSON.stringify({disasterFixtureFilesAndS3Cleaned:true}))
      }
    }finally{await target.quit()}
  }finally{await source.quit()}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
