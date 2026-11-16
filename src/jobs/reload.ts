import logger from '../services/logger';
import { Reload } from '../services/reload'

export class ReloadJob {
  private reload: Reload
  private static inFlight: Map<string, Promise<void>> = new Map()

  constructor(reload: Reload) {
    this.reload = reload
  }

  async consume(_: string, { phone }: { phone: string }) {
    const previous = ReloadJob.inFlight.get(phone)
    const task = (previous || Promise.resolve()).catch(() => {}).then(() => this.reload.run(phone))
    ReloadJob.inFlight.set(phone, task)
    logger.debug('Reload job run for phone %s', phone)
    try {
      await task
    } finally {
      if (ReloadJob.inFlight.get(phone) === task) ReloadJob.inFlight.delete(phone)
    }
  }
}
