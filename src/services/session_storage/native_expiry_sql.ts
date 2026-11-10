/** Keep each expiry lookup an exact (domain,record_id) primary-key search.
 * A correlated IN(id,id||suffix) can choose the deadline-range index instead,
 * scanning every expired row for every message and blocking socket heartbeats.
 * Both predicates bind the same clock twice and preserve imported byte TTLs.
 */
const messageExpired = `EXISTS(SELECT 1 FROM uno_native_expiry e WHERE e.domain='msg' AND e.record_id=m.message_id AND e.expires_at<=?)`
const bytesExpired = `EXISTS(SELECT 1 FROM uno_native_expiry e WHERE e.domain='msg' AND e.record_id=m.message_id||':message_bytes' AND e.expires_at<=?)`
export const NATIVE_MESSAGE_ALIVE_SQL = `NOT ${messageExpired} AND NOT ${bytesExpired}`
export const NATIVE_MESSAGE_EXPIRED_SQL = `${messageExpired} OR ${bytesExpired}`

// MIN + IN can choose the expires_at index and scan a whole domain on every
// upsert. Aggregate only AFTER two exact primary-key lookups, including imports.
export const NATIVE_RECORD_DEADLINE_SQL = `SELECT MIN(deadline) AS deadline FROM (
  SELECT expires_at AS deadline FROM uno_native_expiry WHERE domain=? AND record_id=?
  UNION ALL SELECT expires_at AS deadline FROM uno_native_expiry WHERE domain=? AND record_id=?)`
