import assert from 'node:assert/strict'
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3'

// Run inside the local web container. Never print environment values or response bodies.
assert.equal(process.env.UNOAPI_SERVER_NAME, 'mobile_lab')
assert.equal(process.env.STORAGE_BUCKET_NAME, 'viperconnect-lab')
assert.equal(process.env.REDIS_URL, 'redis://redis:6379')
assert.equal(process.env.AUTO_CONNECT, 'false')
const headers = { Authorization: `Bearer ${process.env.UNOAPI_AUTH_TOKEN}` }
for (const path of ['/', '/ping', '/manager/me']) {
  const response = await fetch(`http://127.0.0.1:9876${path}`, { headers, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200, `HTTP ${path}`)
  console.log(`OK: ${path}`)
}
const unauthorized = await fetch('http://127.0.0.1:9876/manager/me')
assert.equal(unauthorized.status, 401)
const response = await fetch('http://127.0.0.1:9876/sessions', { headers })
assert.equal(response.status, 200)
const sessions = await response.json()
assert.ok(Array.isArray(sessions.data))
assert.equal(sessions.data.length, 0, 'Validação inicial requer laboratório sem sessões.')
console.log('OK: acesso administrativo protegido e nenhuma sessão importada.')
const client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY },
  maxAttempts: 1,
})
try {
  await client.send(new HeadBucketCommand({ Bucket: 'viperconnect-lab' }), { abortSignal: AbortSignal.timeout(15000) })
  console.log('OK: bucket viperconnect-lab acessível (HeadBucket; nenhum objeto gravado ou excluído).')
} catch (error) {
  console.error(`Falha no acesso ao bucket de laboratório: HTTP ${error?.$metadata?.httpStatusCode || 'indisponível'}.`)
  process.exitCode = 1
} finally {
  client.destroy()
}
