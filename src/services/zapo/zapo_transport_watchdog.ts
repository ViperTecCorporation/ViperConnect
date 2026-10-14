import logger from '../logger'

/** Observe the official local transport state, without extra network pings. */
export class ZapoTransportWatchdog {
  private timer?: NodeJS.Timeout
  private generation = 0
  private offlineSince?: number
  private announcedOffline = false
  private timeoutFailures = 0

  start(readConnected: () => boolean, active: () => boolean,
    availability: (online: boolean) => Promise<void>, recover: () => Promise<void>) {
    this.stop()
    const generation = this.generation
    let busy = false
    const tick = async () => {
      if (busy || generation !== this.generation || !active()) return
      busy = true
      try {
        if (readConnected()) {
          this.offlineSince = undefined
          if (this.announcedOffline) {
            await availability(true)
            if (generation !== this.generation) return
            this.announcedOffline = false
          }
        } else {
          this.offlineSince ??= Date.now()
          if (!this.announcedOffline) {
            await availability(false)
            if (generation !== this.generation) return
            this.announcedOffline = true
          }
          if (generation === this.generation && active() && Date.now() - this.offlineSince >= 60_000) {
            await recover()
          }
        }
      } finally { busy = false }
    }
    this.timer = setInterval(() => { void tick().catch(() => logger.warn('ZAPO_TRANSPORT_WATCHDOG_FAILED')) }, 15_000)
    this.timer.unref?.()
  }

  /** Three consecutive provider IQ timeouts; media/HTTP errors never count. */
  failed(error: unknown): boolean {
    if (!(error instanceof Error) || !/^query timeout \(.+\) after \d+ms$/.test(error.message)) {
      this.timeoutFailures = 0
      return false
    }
    return ++this.timeoutFailures >= 3
  }

  succeeded() { this.timeoutFailures = 0 }

  stop() {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.offlineSince = undefined
    this.announcedOffline = false
    this.timeoutFailures = 0
  }
}
