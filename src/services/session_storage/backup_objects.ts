import { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { STORAGE_OPTIONS } from '../../defaults'
import { SessionStorageError } from './types'
import type { SessionBackupObjectStore } from './backup'

export interface BackupObjects extends SessionBackupObjectStore {
  remove(key: string): Promise<void>
  json(key: string): Promise<{ value: unknown; etag: string; modifiedAt?: number } | undefined>
  putJson(key: string, value: unknown, previous: string | null): Promise<boolean>
  keys(prefix: string): AsyncIterable<string>
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const scope = '(?:session-storage/[1-9]\\d{7,14}|(?:redis|voip)/[A-Za-z0-9_.-]{1,100})'
const allowed = new RegExp(`^backups/${scope}/(?:${uuid}\\.(?:viperstorage|vipervoip|rdb\\.viperbackup)(?:\\.manifest\\.json)?|slots/[0-6]\\.json|uploads/${uuid}\\.(?:viperstorage|upload\\.json))$`, 'i')
const absent = (error: any) => error?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name)
const checked = (key: string) => { if (!allowed.test(key)) throw new SessionStorageError(403, 'session_storage_backup_object_scope_invalid'); return key }

/** Separate private backup namespace; never schedules media deletion or accepts arbitrary paths. */
export function createBackupObjects(storage?: Record<string, unknown>): BackupObjects {
  const options = STORAGE_OPTIONS(storage), client = new S3Client({ ...options, maxAttempts: 3, requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, socketTimeout: 30000 }) }), bucket = options.bucket
  return {
    save: async (key, body) => {
      const upload = new Upload({ client, params: { Bucket: bucket, Key: checked(key), Body: body, ContentType: 'application/octet-stream' }, queueSize: 1, partSize: 5 * 1024 * 1024 })
      await upload.done()
    },
    open: async key => {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: checked(key) }))
        if (!(result.Body instanceof Readable)) throw new SessionStorageError(503, 'session_storage_backup_object_unavailable')
        return result.Body
      } catch (error) { if (absent(error)) throw new SessionStorageError(404, 'session_storage_backup_not_found'); throw error }
    },
    remove: async key => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: checked(key) })) },
    json: async key => {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: checked(key) }))
        const stream = result.Body as Readable, chunks: Buffer[] = []; let bytes = 0
        if (!stream || !result.ETag) throw new SessionStorageError(503, 'session_storage_backup_pointer_unavailable')
        try {
          for await (const part of stream) { bytes += part.length; if (bytes > 16384) throw new SessionStorageError(409, 'session_storage_backup_pointer_invalid'); chunks.push(Buffer.from(part)) }
          return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: result.ETag, modifiedAt: result.LastModified?.getTime() }
        } finally { stream.destroy() }
      } catch (error) { if (absent(error)) return undefined; throw error }
    },
    putJson: async (key, value, previous) => {
      const body = JSON.stringify(value)
      if (Buffer.byteLength(body) > 16384) throw new SessionStorageError(409, 'session_storage_backup_pointer_invalid')
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: checked(key), Body: body, ContentType: 'application/json',
          ...(previous === null ? { IfNoneMatch: '*' } : { IfMatch: previous }) }), { abortSignal: AbortSignal.timeout(30000) })
        return true
      } catch (error: any) { if ([409, 412].includes(error?.$metadata?.httpStatusCode)) return false; throw error }
    },
    keys: async function* (prefix) {
      if (!new RegExp(`^backups/${scope}/$`).test(prefix)) throw new SessionStorageError(403, 'session_storage_backup_object_scope_invalid')
      let continuation: string | undefined
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100, ContinuationToken: continuation }))
        for (const item of page.Contents || []) if (item.Key && item.Key.startsWith(prefix) && allowed.test(item.Key)) yield item.Key
        continuation = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (continuation)
    },
  }
}
