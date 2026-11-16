/* Owner-side DEV fixture only. Never creates a WhatsApp client or sends a webhook. */
async function main() {
  if (process.env.UNOAPI_STORAGE_SYNTHETIC_ONLY !== 'true' || process.env.UNOAPI_SERVER_NAME !== 'mobile_lab') throw new Error('isolated_lab_required')
  const phone = process.env.STORAGE_FIXTURE_PHONE
  if (!/^\d{8,15}$/.test(phone || '')) throw new Error('fixture_phone_required')
  const { getConfigRedis } = require('../dist/src/services/config_redis')
  const { getRedis } = require('../dist/src/services/redis')
  const { sessionStorageRpc } = require('../dist/src/services/session_storage/rpc')
  const { SessionStorageTasks } = require('../dist/src/services/session_storage/tasks')
  const config = await getConfigRedis(phone)
  if (!config.sessionStorage?.fixture || config.autoConnect !== false || config.webhooks?.length) throw new Error('fixture_not_safe')
  const before = await sessionStorageRpc(phone, config, 'metrics'), startedAt = Date.now()
  const task = await sessionStorageRpc(phone, config, 'migrate', [{ target: 'sqlite', confirm: true }])
  console.log(JSON.stringify({ event: 'migration_started', taskId: task.id, phone }))
  const tasks = new SessionStorageTasks(await getRedis())
  let last = 0
  for (;;) {
    const result = await tasks.status(phone, task.id)
    if (Date.now() - last > 30000 || result.status !== 'running') {
      console.log(JSON.stringify({ event: 'migration_progress', status: result.status, progress: result.progress, elapsedMs: Date.now() - startedAt, rssBytes: process.memoryUsage().rss })); last = Date.now()
    }
    if (result.status === 'ready') {
      const fresh = await getConfigRedis(phone)
      const metrics = await sessionStorageRpc(phone, fresh, 'metrics')
      console.log(JSON.stringify({ event: 'migration_verified', result: result.result, beforeWorker: before.worker, afterWorker: metrics.worker, metrics, realSends: 0, productionWrites: 0 })); return
    }
    if (result.status !== 'running') throw new Error(result.error || result.status)
    if (Date.now() - startedAt > 30 * 60000) throw new Error('migration_test_timeout')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(JSON.stringify({ event: 'migration_test_failed', error: error.message })); process.exit(1) })
