import { amqpPublish } from '../amqp'
import { UNOAPI_EXCHANGE_BROKER_NAME, UNOAPI_QUEUE_BULK_STATUS } from '../defaults'
import type { getConfig } from './config'
import logger from './logger'
import type { Outgoing } from './outgoing'
import { normalizeUserOrGroupIdForWebhook } from './transformer'
import type { VideoPreparationJobData } from './video_preparation_types'

export class VideoPreparationFailureReporter {
  constructor(
    private readonly getConfig: getConfig,
    private readonly outgoing: Outgoing,
  ) {}

  async report(phone: string, data: VideoPreparationJobData, error: unknown) {
    const config = await this.getConfig(phone)
    const recipientId = normalizeUserOrGroupIdForWebhook(data.payload?.to || '')
    // Do not expose ffmpeg stderr, file paths or signed source URLs in the webhook.
    const oversized = `${(error as any)?.message || ''}`.startsWith('video_output_too_large:')
    const message = oversized
      ? 'VIDEO_OUTPUT_TOO_LARGE: Vídeo excede o teto de saída configurado. Escolha SD, corte o vídeo ou envie como documento quando suportado. A qualidade não foi reduzida automaticamente.'
      : 'VIDEO_PREPARATION_FAILED: Não foi possível preparar o vídeo. Verifique o arquivo e os parâmetros recomendados na documentação.'
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: phone,
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: phone, phone_number_id: phone },
            statuses: [{
              id: data.id,
              recipient_id: recipientId,
              status: 'failed',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              errors: [{
                code: 131053,
                title: 'Media upload error',
                message: `UnoAPI could not prepare the video: ${message}`,
              }],
            }],
          },
          field: 'messages',
        }],
      }],
    }
    await amqpPublish(
      UNOAPI_EXCHANGE_BROKER_NAME,
      UNOAPI_QUEUE_BULK_STATUS,
      phone,
      { payload, type: 'whatsapp' },
      { type: 'topic', priority: 1 },
    )
    await Promise.all(config.webhooks.map((webhook) => this.outgoing.sendHttp(phone, webhook, payload, { priority: 1 })))
    logger.warn('Reported permanent video preparation failure phone=%s id=%s', phone, data.id)
  }
}
