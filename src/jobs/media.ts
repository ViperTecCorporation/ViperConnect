import { getConfig } from '../services/config'
import logger from '../services/logger'

export class MediaJob {
  private getConfig: getConfig

  constructor(getConfig: getConfig) {
    this.getConfig = getConfig
  }

  async consume(phone: string, data: object) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = data as any
    const fileName: string = a.fileName
    const config = await this.getConfig(phone)
    const { mediaStore } = await config.getStore(phone, config)
    // Restore parts may already have been deleted after completion/cancellation.
    // Their delayed retention job must not create errors for absent objects.
    if (/^session-restore-uploads\/[0-9a-f-]{36}\/\d+\.part$/.test(fileName) && !await mediaStore.hasMedia(fileName)) return
    logger.debug('Removing file %s...', fileName)
    await mediaStore.removeMedia(fileName)
    logger.debug('Remove file %s!', fileName)
  }
}
