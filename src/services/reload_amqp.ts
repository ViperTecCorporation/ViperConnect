import { amqpPublish } from '../amqp'
import { RELOAD_PUBLISH_BROKER, UNOAPI_EXCHANGE_BRIDGE_NAME, UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_RELOAD } from '../defaults'
import { getConfig } from './config'
import { Reload } from './reload'
import { providerQueueName } from './providers/provider_queue'

export class ReloadAmqp extends Reload {
  private getConfig: getConfig

  constructor(getConfig: getConfig) {
    super()
    this.getConfig = getConfig
  }

  public async run(phone: string) {
    const config = await this.getConfig(phone)
    if (RELOAD_PUBLISH_BROKER) {
      await amqpPublish(
        UNOAPI_EXCHANGE_BROKER_NAME,
        UNOAPI_QUEUE_RELOAD,
        phone,
        { phone },
        { type: 'topic' }
      )
    }
    // Only Zapo has a runtime worker. Keep invalidation even for legacy config
    // so a previously cached Zapo client can be cleared without reviving Baileys.
    await amqpPublish(
      UNOAPI_EXCHANGE_BRIDGE_NAME,
      providerQueueName(UNOAPI_QUEUE_RELOAD, config.server || 'server_1', 'zapo'),
      '',
      { phone },
      { type: 'direct' }
    )
  }
}
