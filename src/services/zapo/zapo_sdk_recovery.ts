import { SendError } from '../send_error'

export type ZapoConnectRunner = (connect: () => Promise<void>) => Promise<void>

/** SDK recovery calls the public connect method too. Never restore the unguarded method on disposal. */
export function guardZapoSdkConnect<T extends { connect(): Promise<void> }>(client: T, run: ZapoConnectRunner): T {
  const connect = client.connect.bind(client)
  client.connect = () => run(connect)
  return client
}

/** A bounded handoff, not a second reconnect loop or a version resolver. */
export class ZapoSdkRecovery {
  private episode?: {
    ready: Promise<void>; markReady: () => void
    done: Promise<void>; finish: () => void
    attempted: boolean; timer: NodeJS.Timeout
  }
  private disposed = false

  constructor(private readonly expired: () => void, private readonly timeoutMs = 45_000) {}

  get active() { return !!this.episode }

  begin() {
    if (this.disposed || this.episode) return false
    let markReady!: () => void, finish!: () => void
    const ready = new Promise<void>(resolve => { markReady = resolve })
    const done = new Promise<void>(resolve => { finish = resolve })
    const timer = setTimeout(() => { this.complete(); this.expired() }, this.timeoutMs)
    timer.unref?.()
    this.episode = { ready, markReady, done, finish, attempted: false, timer }
    return true
  }

  ready() { this.episode?.markReady() }
  wait() { return this.episode?.done ?? Promise.resolve() }

  /** At most one SDK reconnect per episode; late fetches cannot revive a cancelled instance. */
  async claim() {
    const episode = this.episode
    if (!episode || episode.attempted) throw new SendError(409, 'zapo_sdk_recovery_not_pending')
    episode.attempted = true
    await episode.ready
    if (this.disposed || this.episode !== episode) throw new SendError(409, 'zapo_operation_cancelled')
  }

  complete() {
    const episode = this.episode
    this.episode = undefined
    if (!episode) return
    clearTimeout(episode.timer)
    episode.markReady()
    episode.finish()
  }

  cancel() { this.disposed = true; this.complete() }
}
