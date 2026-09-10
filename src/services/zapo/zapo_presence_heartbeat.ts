import type { WaClient } from 'zapo-js'
import logger from '../logger'

export const ZAPO_PRESENCE_INTERVAL_MS = 3 * 60 * 60 * 1000

/** One in-memory presence loop per connected socket; never overlaps sends. */
export class ZapoPresenceHeartbeat {
  private timer?: NodeJS.Timeout
  private generation = 0

  constructor(private readonly phone: string) {}

  start(client: Pick<WaClient, 'presence'>, markOnline: boolean, isCurrent: () => boolean) {
    if (this.timer) return
    const generation = ++this.generation
    let busy = false
    const active = () => generation === this.generation && isCurrent()
    const pulse = async () => {
      if (!active() || busy) return
      busy = true
      try {
        try {
          await client.presence.send('available')
        } finally {
          // Also attempt restoration after a rejected send; delivery may be ambiguous.
          if (!markOnline && active()) await client.presence.send('unavailable')
        }
        if (active()) logger.info('ZAPO_PRESENCE_HEARTBEAT phone=%s markOnline=%s', this.phone, markOnline)
      } catch (error) {
        if (active()) logger.warn(error as any, 'ZAPO_PRESENCE_HEARTBEAT_FAILED phone=%s', this.phone)
      } finally {
        busy = false
      }
    }
    this.timer = setInterval(() => { void pulse() }, ZAPO_PRESENCE_INTERVAL_MS)
    this.timer.unref?.()
    void pulse()
  }

  stop() {
    this.generation += 1
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
