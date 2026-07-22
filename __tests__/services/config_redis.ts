jest.mock('../../src/services/redis')
import { getConfig } from '../../src/services/redis'
import { getConfigRedis } from '../../src/services/config_redis'
import { configs } from '../../src/services/config'
import { WEBHOOK_HEADER, WHATSAPP_ENGINE } from '../../src/defaults'
import { resolveSessionProvider } from '../../src/services/providers/provider_resolver'
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>

describe('service config redis', () => {
  beforeEach(() => {
    configs.clear()
  })

  test('use redis', async () => {
    const ignoreGroupMessages = false
    mockGetConfig.mockResolvedValue({ ignoreGroupMessages })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.ignoreGroupMessages).toBe(ignoreGroupMessages)
  })

  test('use default', async () => {
    mockGetConfig.mockResolvedValue(undefined)
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.ignoreGroupMessages).toBe(true)
    expect(config.ignoreBroadcastMessages).toBe(false)
    expect(config.provider).toBe(resolveSessionProvider(WHATSAPP_ENGINE))
  })

  test('keeps a persisted legacy session on Baileys when provider is absent', async () => {
    mockGetConfig.mockResolvedValue({ autoConnect: true })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.provider).toBe('baileys')
  })

  // test('use env', async () => {
  //   console.log('>>>>>>>>>>', JSON.stringify(process.env.IGNORE_GROUP_MESSAGES))
  //   const copy = process.env.IGNORE_GROUP_MESSAGES
  //   process.env['IGNORE_GROUP_MESSAGES'] = 'false'
  //   mockGetConfig.mockResolvedValue({})
  //   const config = await getConfigRedis(`${new Date().getTime()}`)
  //   process.env.IGNORE_GROUP_MESSAGES = copy
  //   expect(config.ignoreGroupMessages).toBe(false)
  // })

  test('use webhook url redis', async () => {
    const url = `${new Date().getTime()}${new Date().getTime()}`
    mockGetConfig.mockResolvedValue({ webhooks: [{ url }] })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.webhooks[0].url).toBe(url)
  })

  test('use webhook header redis with value in env too', async () => {
    const headerEnv = `${new Date().getTime()}-env`
    const copy = process.env.WEBHOOK_HEADER
    process.env.WEBHOOK_HEADER = headerEnv
    const headerRedis = `${new Date().getTime()}-redis`
    mockGetConfig.mockResolvedValue({ webhooks: [{ url: 'http....', header: headerRedis }] })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    process.env.WEBHOOK_HEADER = copy
    expect(config.webhooks[0].header).toBe(headerRedis)
  })

  test('use webhook header env where not in redis', async () => {
    mockGetConfig.mockResolvedValue({ webhooks: [{}] })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.webhooks[0].header).toBe(WEBHOOK_HEADER)
  })

  test('uses webhook enabled flag from redis', async () => {
    mockGetConfig.mockResolvedValue({ webhooks: [{ enabled: false }] })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.webhooks[0].enabled).toBe(false)
  })

  test('normalizes an invalid history window stored in redis', async () => {
    mockGetConfig.mockResolvedValue({ historyMaxAgeDays: 0 })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.historyMaxAgeDays).toBe(30)
  })

  test('forces direct-chat addressing to LID even when Redis contains PN', async () => {
    mockGetConfig.mockResolvedValue({ oneToOneAddressingMode: 'pn' })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.oneToOneAddressingMode).toBe('lid')
  })

  test('removes the legacy fake base URL when an absolute webhook exists', async () => {
    mockGetConfig.mockResolvedValue({ webhooks: [{
      url: 'http://localhost:9876/webhooks/fake',
      urlAbsolute: 'https://chatwoot.local/webhook',
    }] })
    const config = await getConfigRedis(`${new Date().getTime()}`)
    expect(config.webhooks[0].url).toBe('')
    expect(config.webhooks[0].urlAbsolute).toBe('https://chatwoot.local/webhook')
  })

  test('get media store', async () => {
    const phone = `${new Date().getTime()}`
    const config = await getConfigRedis(phone)
    config.useS3 = true
    config.useRedis = true
    const store = await config.getStore(phone, config)
    const { mediaStore } = store
    expect(mediaStore.type).toBe('s3')
  })
})
