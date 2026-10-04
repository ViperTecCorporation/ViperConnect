import type { Server, Socket } from 'socket.io'
import type Redis from 'ioredis'
import type { getConfig } from '../config'
import { authorizedSessionMessages, SessionMessages } from './session_messages'
import { MESSAGE_CHANGE_CHANNEL } from './session_message_index'

const installed = new WeakSet<Server>()
export const installSessionMessageSocket = (io: Server, load: getConfig) => {
  if (installed.has(io)) return
  installed.add(io)
  const subscriptions = new Map<Socket, { phone: string; token: string }>()
  let subscriber: Redis | undefined
  let starting: Promise<void> | undefined
  const subscribeRedis = (redis: Redis) => {
    if (starting) return starting
    starting = (async () => {
      subscriber = redis.duplicate()
      subscriber.on('error', () => { /* HTTP reads remain available; Socket.IO reconnect reloads. */ })
      subscriber.on('message', async (_channel, raw) => {
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { return }
        if (!parsed || typeof parsed.phone !== 'string' || typeof parsed.conversation_id !== 'string') return
        const outgoing = parsed.outgoing
        const change = { phone: parsed.phone, conversation_id: parsed.conversation_id.slice(0, 200),
          ...(typeof parsed.id === 'string' ? { id: parsed.id.slice(0, 200) } : {}),
          ...(outgoing && typeof outgoing.id === 'string' && ['sent', 'failed', 'delivered', 'read', 'played'].includes(outgoing.status) ? {
            outgoing: { id: outgoing.id.slice(0, 200), status: outgoing.status, ...(outgoing.status === 'failed' ? { error: 'O envio falhou no worker. Consulte o diagnóstico do webhook.' } : {}) },
          } : {}),
        }
        await Promise.all([...subscriptions].filter(([, sub]) => sub.phone === change.phone).map(async ([socket, sub]) => {
          try {
            if (!await authorizedSessionMessages(sub.token, sub.phone, load)) {
              subscriptions.delete(socket); socket.emit('messages:error', { error: 'session_messages_forbidden' }); return
            }
            if (subscriptions.get(socket) === sub) socket.emit('messages:changed', change)
          } catch { socket.emit('messages:error', { error: 'session_messages_unavailable' }) }
        }))
      })
      await subscriber.subscribe(MESSAGE_CHANGE_CHANNEL)
    })().catch(error => { subscriber?.disconnect(); subscriber = undefined; starting = undefined; throw error })
    return starting
  }
  io.on('connection', socket => {
    let revision = 0
    socket.on('messages:subscribe', async (payload: any, ack?: (result: any) => void) => {
      const request = ++revision
      subscriptions.delete(socket)
      try {
        const phone = typeof payload?.phone === 'string' ? payload.phone.trim() : ''
        const token = typeof payload?.token === 'string' && payload.token.length <= 512 ? payload.token : ''
        if (!await authorizedSessionMessages(token, phone, load)) throw new Error('session_messages_forbidden')
        const index = await new SessionMessages(load).index(phone)
        await subscribeRedis(index.redis)
        if (revision !== request || !socket.connected) return
        subscriptions.set(socket, { phone, token })
        ack?.({ subscribed: true })
      } catch { ack?.({ error: 'session_messages_forbidden_or_unavailable' }) }
    })
    socket.on('messages:unsubscribe', () => { revision++; subscriptions.delete(socket) })
    socket.on('disconnect', () => { revision++; subscriptions.delete(socket) })
  })
  io.engine?.on('close', () => { subscriptions.clear(); subscriber?.disconnect() })
}
