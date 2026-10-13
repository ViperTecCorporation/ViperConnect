export const isTransientBaileysError = (reason: any): boolean => {
  try {
    const msg = `${(reason && (reason.message || reason.msg || reason.toString?.())) || ''}`
      .toLowerCase()
    const statusCode = (reason && (reason.status || reason.statusCode || (reason as any)?.output?.statusCode)) || undefined
    const boomMsg = `${(reason && (reason as any)?.output?.payload?.message) || ''}`.toLowerCase()
    const data = getBaileysErrorData(reason)

    // Common transient/network cases seen from Baileys/libsignal
    if (msg.includes('connection closed')) return true
    if (boomMsg.includes('connection closed')) return true
    if (statusCode === 428) return true // Precondition Required (Boom) used by Baileys on closed socket
    if (data?.retryAfterReconnect && data?.retriable) return true

    // Some environments surface this as generic Error without boom payload
    if (msg.includes('precondition required')) return true

    return false
  } catch {
    return false
  }
}

export const isTransientInfraError = (reason: any): boolean => {
  try {
    const err = reason || {}
    const code = `${err.code || err.errno || ''}`.toUpperCase()
    const msg = `${(err && (err.message || err.msg || err.toString?.())) || ''}`.toLowerCase()

    if (['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
      return true
    }

    if (code === 'ENOTFOUND') {
      return msg.includes('redis') || msg.includes('rabbitmq') || msg.includes('amqp')
    }

    if (msg.includes('getaddrinfo eai_again')) return true
    if (msg.includes('temporary failure in name resolution')) return true
    if (msg.includes('connection refused')) return true
    if (msg.includes('timed out')) return true

    return false
  } catch {
    return false
  }
}

export const isTransientExternalIoError = (reason: any): boolean => {
  try {
    const err = reason || {}
    const code = `${err.code || err.errno || ''}`.toUpperCase()
    const name = `${err.name || ''}`.toLowerCase()
    const msg = `${err.message || err.msg || err.toString?.() || ''}`.trim().toLowerCase()
    const stack = `${err.stack || ''}`.toLowerCase()

    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code)) return true
    if (name === 'aborterror') return true

    // Node's HTTPS client can surface a peer-closed response without a code.
    // Restrict the generic "aborted" match to its client stack so unrelated
    // application errors are still treated as fatal.
    if (msg === 'aborted' && (stack.includes('node:_http_client') || stack.includes('socketcloselistener'))) {
      return true
    }

    return false
  } catch {
    return false
  }
}

const getBaileysErrorData = (reason: any) => {
  return reason?.data || reason?.output?.payload?.data || reason?.output?.data
}

export interface RetryableStaleSendPayload {
  targetJid: string
  fullMessage?: {
    message?: any
  }
  relayOptions?: Record<string, unknown>
}

export const isRetryableStaleSendError = (reason: any): boolean => {
  try {
    const data = getBaileysErrorData(reason)
    return !!(data?.retryAfterReconnect && data?.retriable && data?.retryableSend?.targetJid)
  } catch {
    return false
  }
}

export const getRetryableStaleSendPayload = (reason: any): RetryableStaleSendPayload | undefined => {
  try {
    if (!isRetryableStaleSendError(reason)) return undefined
    const data = getBaileysErrorData(reason)
    return data?.retryableSend
  } catch {
    return undefined
  }
}

