import { useViperVoiceBaileys, type ViperVoiceAdapterHandle } from '@viperconnect/baileys-voice-adapter'
import type { WASocket } from '@whiskeysockets/baileys'
import type { Config } from './config'
import logger from './logger'
import { setConfig } from './redis'

const adapters = new Map<string, ViperVoiceAdapterHandle>()

const digitsOnly = (value: string) => `${value || ''}`.replace(/\D/g, '')
const logArgs = (args: any[]) => args.map((arg) => {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'string') return arg
  try { return JSON.stringify(arg) } catch { return `${arg}` }
}).join(' ')

export const closeVoiceBridge = (phone: string, reason = 'session_closed') => {
  const adapter = adapters.get(phone)
  if (!adapter) return
  adapters.delete(phone)
  try {
    adapter.close()
    logger.info('Closed Viper voice bridge for %s (%s)', phone, reason)
  } catch (error) {
    logger.warn(error as any, 'Failed to close Viper voice bridge for %s (%s)', phone, reason)
  }
}

export const attachVoiceBridge = async (options: {
  phone: string
  sock: WASocket
  config: Partial<Config>
}) => {
  const serviceUrl = `${options.config.voipServiceUrl || ''}`.trim()
  const provisionToken = `${options.config.voipServiceToken || ''}`.trim()
  const slotId = `${options.config.voipSlotId || ''}`.trim() || undefined
  if (!serviceUrl || !provisionToken) return undefined

  closeVoiceBridge(options.phone, 'reattach')

  const phoneNumber = digitsOnly(options.phone)
  try {
    const adapter = await useViperVoiceBaileys({
      sock: options.sock as any,
      serviceUrl,
      provisionToken,
      slotId,
      software: 'unoapi-baileys-v7',
      instanceId: `unoapi:${options.phone}`,
      phoneNumber,
      displayName: phoneNumber ? `Uno ${phoneNumber}` : `Uno ${options.phone}`,
      selfJid: options.sock.authState?.creds?.me?.id,
      selfLid: options.sock.authState?.creds?.me?.lid,
      logger: {
        debug: (...args: any[]) => logger.debug(logArgs(args)),
        info: (...args: any[]) => logger.info(logArgs(args)),
        warn: (...args: any[]) => logger.warn(logArgs(args)),
        error: (...args: any[]) => logger.error(logArgs(args)),
      },
    })
    adapters.set(options.phone, adapter)
    const provisionedSlotId = adapter.provision?.slot?.id || adapter.slotId
    if (provisionedSlotId && provisionedSlotId !== slotId) {
      await setConfig(options.phone, { voipSlotId: provisionedSlotId })
    }
    logger.info(
      'Attached Viper voice bridge for %s slot=%s sipUser=%s',
      options.phone,
      provisionedSlotId || '<existing>',
      adapter.provision?.sip?.username || '<none>',
    )
    return adapter
  } catch (error) {
    logger.warn(error as any, 'Failed to attach Viper voice bridge for %s', options.phone)
    return undefined
  }
}
