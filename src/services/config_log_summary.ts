import type { Config } from './config'

export const configLogSummary = (config: Partial<Config>) => {
  const webhooks = Array.isArray(config.webhooks) ? config.webhooks : []

  return {
    provider: config.provider || '<none>',
    server: config.server || '<none>',
    connection_type: config.connectionType || '<none>',
    zapo_web_client_profile: config.zapoWebClientProfile || 'default',
    log_level: config.logLevel || '<none>',
    use_redis: config.useRedis === true,
    use_s3: config.useS3 === true,
    auto_connect: config.autoConnect === true,
    ignore_group_messages: config.ignoreGroupMessages === true,
    ignore_newsletter_messages: config.ignoreNewsletterMessages === true,
    webhook_count: webhooks.length,
    enabled_webhook_count: webhooks.filter((webhook) => webhook?.enabled !== false).length,
    typebot_webhook_count: webhooks.filter((webhook) => webhook?.typebot === true).length,
  }
}
