import type Redis from 'ioredis'

/** Only the task that suspended this configuration may restore its prior connection setting. */
export async function recoverBackupConnection(redis: Redis, key: string, phone: string, owner: string, previous: boolean | undefined, reconnect: () => Promise<unknown>) {
  const changed = await redis.eval(`
    local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
    local cfg=cjson.decode(raw)
    if cfg.provider ~= 'zapo' or cfg.mobilePrimaryDraftId or cfg.sessionTransferDeleting or cfg.autoConnect ~= false or cfg.sessionTransferBackupId ~= ARGV[3] then return 0 end
    cfg.autoConnect=cjson.decode(ARGV[1]); cfg.sessionTransferBackupId=nil
    redis.call('SET',KEYS[1],cjson.encode(cfg)); redis.call('PUBLISH','unoapi-config:update',ARGV[2]); return 1`,
    1, key, JSON.stringify(previous ?? true), phone, owner)
  if (Number(changed) === 1 && previous !== false) await reconnect()
  return Number(changed) === 1
}
