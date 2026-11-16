// Storage-only microbenchmark, not 100 connected WhatsApp clients.
const assert=require('node:assert/strict'),{mkdtemp,rm,realpath}=require('node:fs/promises'),{join,sep}=require('node:path')
async function main(){
  assert.equal(process.env.QA_CAPACITY_CONFIRM,'isolated-lab-storage-only');assert.equal(process.env.UNOAPI_SERVER_NAME,'mobile_lab')
  const {SessionDatabase}=require('/app/dist/src/services/session_storage/database.js'),root=await mkdtemp('/tmp/viper-capacity-'),open=[]
  const before=process.memoryUsage(),start=Date.now()
  try{
    for(let n=0;n<100;n++){
      const db=new SessionDatabase(join(root,n+'.sqlite'));open.push(db)
      db.transaction(()=>{for(let i=0;i<256;i++)db.putValue('synthetic:'+i,Buffer.alloc(4096,n%255))})
      db.get('SELECT SUM(length(value)) n FROM uno_kv')
    }
    const after=process.memoryUsage();console.log(JSON.stringify({storageOnly:true,databases:100,rowsPerDatabase:256,valueBytes:4096,
      elapsedMs:Date.now()-start,rssBefore:before.rss,rssAfter:after.rss,rssDelta:after.rss-before.rss,
      noWhatsappClients:true,noNetworkCalls:true,notPerSessionProductionRam:true}))
  }finally{for(const db of open)db.close();const target=await realpath(root);assert.ok(target.startsWith('/tmp'+sep+'viper-capacity-'));await rm(target,{recursive:true,force:true});console.log(JSON.stringify({capacityFixtureCleaned:true}))}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
