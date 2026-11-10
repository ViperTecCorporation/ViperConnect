/** All catalogue/primary records commit together only while the new target remains absent. */
export const COMMIT_STANDALONE_RESTORE_LUA = `
if redis.call('GET',KEYS[2])~=ARGV[1] or redis.call('GET',KEYS[3])~=ARGV[1] then return -1 end
if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[5])==1 then return 0 end
for i=12,#KEYS do if redis.call('EXISTS',KEYS[i])==1 then return -3 end end
for _,pair in ipairs({{KEYS[4],'set'},{KEYS[6],'hash'},{KEYS[10],'set'},{KEYS[11],'string'}}) do local t=redis.call('TYPE',pair[1]).ok; if t~='none' and t~=pair[2] then return -2 end end
local cfg=cjson.decode(ARGV[3]); local primary=ARGV[4]~=''
if cfg.provider~='zapo' or cfg.autoConnect~=false or not cfg.sessionStorage or cfg.sessionStorage.backend~='sqlite' or cfg.sessionStorage.state~='offline' then return -2 end
if primary then
 local draft=cjson.decode(ARGV[4]); if cfg.mobilePrimaryDraftId~=draft.id or cfg.mobilePrimaryImported~=true or ARGV[5]=='' then return -2 end
 if redis.call('HEXISTS',KEYS[6],draft.phone)==1 or redis.call('HEXISTS',KEYS[6],ARGV[2])==1 or redis.call('HLEN',KEYS[6])>=100 or redis.call('EXISTS',KEYS[7])==1 or redis.call('EXISTS',KEYS[8])==1 or redis.call('EXISTS',KEYS[9])==1 then return -3 end
 for _,raw in ipairs(redis.call('HVALS',KEYS[6])) do local ok,old=pcall(cjson.decode,raw); if not ok or type(old)~='table' or old.id==draft.id then return -3 end end
else
 if cfg.mobilePrimaryDraftId or cfg.mobilePrimaryImported then return -2 end
 if redis.call('HEXISTS',KEYS[6],ARGV[2])==1 then return -3 end
end
redis.call('SET',KEYS[1],ARGV[3]); redis.call('SADD',KEYS[4],ARGV[2]); redis.call('SET',KEYS[5],'offline')
if ARGV[7]~='' then redis.call('SADD',KEYS[10],ARGV[7]) end
if primary then local draft=cjson.decode(ARGV[4]); redis.call('HSET',KEYS[6],draft.phone,ARGV[4]); redis.call('SET',KEYS[7],ARGV[5]); if ARGV[6]~='' then redis.call('SET',KEYS[8],ARGV[6]) end end
redis.call('SET',KEYS[11],ARGV[8],'EX',604800); redis.call('PUBLISH','unoapi-config:update',ARGV[2]); redis.call('PUBLISH','unoapi-status:update',ARGV[2]); return 1`

export const RESERVE_STANDALONE_RESTORE_LUA = `
if redis.call('GET',KEYS[2])~=ARGV[1] then return -1 end
if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[3])==1 or redis.call('EXISTS',KEYS[4])==1 or redis.call('EXISTS',KEYS[5])==1 then return 0 end
redis.call('SET',KEYS[3],ARGV[1],'PX',120000); redis.call('SET',KEYS[5],ARGV[2],'EX',604800); return 1`
