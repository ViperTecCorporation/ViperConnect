/* Isolated real HTTP/SQLite/S3 backup + restore; only a labelled synthetic VoIP container. */
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const { createServer } = require('node:http')
const app = createRequire('/app/package.json')
async function main() {
  assert.equal(process.env.VOIP_BACKUP_SMOKE_CONFIRM, 'synthetic-lab-only')
  assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab'); assert.equal(process.env.REDIS_URL, 'redis://redis:6379'); assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
  const serviceUrl = 'http://viperconnect-voip-backup-fixture-20261110:3097', serviceToken = 'synthetic-voip-backup-fixture-only'
  const instance = 'qa-voip-' + randomUUID(); process.env.VOIP_BACKUP_INSTANCE_ID = instance
  const { VoipService } = app('/app/dist/src/services/voip_service.js'), { VoipBackups } = app('/app/dist/src/services/voip_backups.js')
  const { voipBackupRouter } = app('/app/dist/src/controllers/voip_backup_controller.js')
  const { createBackupObjects } = app('/app/dist/src/services/session_storage/backup_objects.js')
  const service = new VoipService(serviceUrl, serviceToken, 60000), backend = new VoipBackups(service)
  const redis = new (app('ioredis'))(process.env.REDIS_URL), objects = createBackupObjects(), ids = new Set()
  const server = createServer(app('express')().use('/manager/voip-backups', voipBackupRouter(backend, { authenticate: async token => token === 'synthetic-manager' ? { role: 'admin', kind: 'login' } : undefined })))
  let success = false, requests = 0
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/manager/voip-backups`
    const headers = { Authorization: 'Bearer synthetic-manager' }
    const json = async (suffix = '', body, expected = 200) => {
      const r = await fetch(base + suffix, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) })
      requests++; const result = await r.json(); assert.equal(r.status, expected, result.error || 'http_status')
      if (result.id) ids.add(result.id); if (result.beforeBackupId) ids.add(result.beforeBackupId); return result
    }
    const initial = await json(); assert.equal(initial.enabled, true); assert.ok(initial.prefix.includes(instance))
    const backup = await json('', { confirm: true }); assert.equal(backup.uploadVerified, true); assert.equal(backup.recordingsIncluded, false)
    const download = await fetch(base + '/' + backup.id + '/download', { headers }); requests++; assert.equal(download.status, 200)
    const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(bytes.length, backup.bytes)
    const update = await fetch(serviceUrl + '/v1/console/extensionGroups/qa-hold-group', { method: 'PUT', headers: { Authorization: 'Bearer ' + serviceToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: 'empresa-padrao', enabled: true, extensionIds: [], label: 'Changed after snapshot' }) })
    requests++; assert.equal(update.status, 200)
    const restored = await json('/restore', { backupId: backup.id, confirm: true })
    assert.equal(restored.restored, true); assert.equal(restored.recordingsRestored, false); assert.equal(restored.webhooksEnabled, false); assert.equal(restored.audioFiles, 1)
    const upload = await fetch(base + '/restore-upload?confirm=true', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(90000) })
    requests++; const uploaded = await upload.json(); assert.equal(upload.status, 200, uploaded.error); assert.equal(uploaded.restored, true); ids.add(uploaded.beforeBackupId)
    const after = await service.request('/v1/console/bootstrap'); requests++
    const group = after.config.extensionGroups.find(g => g.id === 'qa-hold-group'); assert.equal(group.transferAudioSource, 'configured'); assert.notEqual(group.label, 'Changed after snapshot')
    const audio = await service.stream('/v1/console/extensionGroups/qa-hold-group/transfer-audio'); requests++
    assert.equal(await audio.text(), 'synthetic-hold-audio')
    assert.equal((await json()).state.phase, 'restored')
    success = true
    console.log(JSON.stringify({ voipBackupE2E: true, requests, s3Verified: true, restoredFromS3: true, restoredFromUpload: true, holdAudioRestored: true, recordingsExcluded: true, realCallsOrMessages: 0 }))
  } finally {
    if (success) {
      for await (const key of objects.keys(`backups/voip/${instance}/`)) {
        const id = key.match(/\/([a-f0-9-]{36})\.vipervoip/)?.[1]; if (id) ids.add(id)
        await objects.remove(key)
      }
      const keys = [`unoapi-infrastructure:voip-backup:state:${instance}`, ...[...ids].map(id => `unoapi-infrastructure:voip-backup:manifest:${id}`)]
      await redis.unlink(...keys); console.log(JSON.stringify({ syntheticVoipBackupCleanup: true }))
    } else console.log(JSON.stringify({ preservedSyntheticVoipBackupPrefix: `backups/voip/${instance}/` }))
    await new Promise(r => server.close(r)); await redis.quit()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1) })
