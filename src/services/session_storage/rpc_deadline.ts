import { SendError } from '../send_error'

const reads = new Set(['status', 'metrics', 'explore', 'query.conversations', 'query.messages', 'query.contacts', 'query.contact', 'query.contact-sync', 'query.record',
  'primary.auth.load', 'standalone.capability', 'standalone.check',
  ...['loadKey', 'loadMessage', 'loadMessageExact', 'findMessageWithSecret', 'loadMediaPayload', 'getImageUrl', 'getGroupMetada', 'loadUnoId', 'loadProviderId', 'loadStatus',
    'getJid', 'getContactName', 'getContactInfo', 'getLastIncomingKey', 'loadTemplates', 'getPnForLid', 'getLidForPn'].map(name => `data.${name}`)])
export const storageReadTimeout = (operation: string): number | undefined => reads.has(operation) ? 15000 : undefined

/** Deadline is accepted only for explicit reads; queued mutations never expire as if cancelled. */
export function assertStorageReadDeadline(request: any, now = Date.now()) {
  if (!reads.has(request.operation) || request.requestedAt === undefined && request.deadlineAt === undefined) return
  if (!Number.isSafeInteger(request.requestedAt) || !Number.isSafeInteger(request.deadlineAt) || request.deadlineAt - request.requestedAt !== 15000
    || request.requestedAt > now + 1000 || request.deadlineAt <= now) throw new SendError(503, 'session_storage_request_expired')
}
