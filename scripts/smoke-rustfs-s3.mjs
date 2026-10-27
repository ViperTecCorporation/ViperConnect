// Opt-in compatibility test. Only a loopback fixture endpoint is accepted.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { S3Client, CreateBucketCommand, PutObjectCommand, HeadObjectCommand,
  GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const validateSmokeEndpoint = (environment) => {
  if (environment.RUSTFS_SMOKE_ENABLED !== '1') throw new Error('explicit_smoke_opt_in_required')
  const endpoint = new URL(environment.RUSTFS_SMOKE_ENDPOINT)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('only_loopback_fixture_endpoint_allowed')
  }
  if (!environment.RUSTFS_SMOKE_ACCESS_KEY || !environment.RUSTFS_SMOKE_SECRET_KEY) {
    throw new Error('fixture_credentials_required')
  }
  return endpoint.origin
}

export const smokeRustfs = async (environment = process.env) => {
  const endpoint = validateSmokeEndpoint(environment)
  const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: environment.RUSTFS_SMOKE_ACCESS_KEY, secretAccessKey: environment.RUSTFS_SMOKE_SECRET_KEY } })
  const bucket = `codex-synthetic-${randomUUID()}`
  const keys = ['synthetic/media.bin', 'synthetic/multipart.bin']
  let created = false
  const hash = (data) => createHash('sha256').update(data).digest('hex')
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); created = true
    const body = Buffer.from('ViperConnect synthetic S3 compatibility fixture\n')
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keys[0], Body: body, ContentType: 'application/octet-stream' }))
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: keys[0] }))
    assert.equal(head.ContentLength, body.length)
    assert.equal(head.ContentType, 'application/octet-stream')
    const get = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keys[0] }))
    assert.equal(hash(await get.Body.transformToByteArray()), hash(body))
    const range = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keys[0], Range: 'bytes=0-9' }))
    assert.deepEqual(Buffer.from(await range.Body.transformToByteArray()), body.subarray(0, 10))
    const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: keys[0] }), { expiresIn: 60 })
    const response = await fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(body))
    const multipart = Buffer.alloc(11 * 1024 * 1024, 42)
    await new Upload({ client: s3, params: { Bucket: bucket, Key: keys[1], Body: multipart },
      partSize: 5 * 1024 * 1024, queueSize: 2, leavePartsOnError: false }).done()
    const downloaded = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keys[1] }))
    assert.equal(hash(await downloaded.Body.transformToByteArray()), hash(multipart))
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'synthetic/' }))
    assert.deepEqual(listing.Contents.map(item => item.Key).sort(), [...keys].sort())
    console.log('RustFS S3: PUT, HEAD, GET, Range, presigned GET, multipart and LIST passed (synthetic fixture only).')
  } finally {
    try {
      if (created) {
        const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }))
        assert.ok(!result.Errors?.length, 'synthetic_object_cleanup_failed')
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
        console.log('Synthetic objects and isolated bucket removed.')
      }
    } finally { s3.destroy() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smokeRustfs()
}
