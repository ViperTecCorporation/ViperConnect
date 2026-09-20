describe('defaults boolean parsing', () => {
  const key = 'STATUS_BROADCAST_ENABLED'

  afterEach(() => {
    delete process.env[key]
    jest.resetModules()
  })

  test('uses the documented fallback when the environment value is absent', () => {
    delete process.env[key]
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../../src/defaults').STATUS_BROADCAST_ENABLED).toBe(true)
  })

  test('does not invert explicit true and false values', () => {
    process.env[key] = 'true'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../../src/defaults').STATUS_BROADCAST_ENABLED).toBe(true)
    process.env[key] = 'false'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('../../src/defaults').STATUS_BROADCAST_ENABLED).toBe(false)
  })
})

describe('defaults locale', () => {
  const previousLocale = process.env.DEFAULT_LOCALE

  afterEach(() => {
    if (typeof previousLocale === 'undefined') delete process.env.DEFAULT_LOCALE
    else process.env.DEFAULT_LOCALE = previousLocale
    jest.resetModules()
  })

  test('uses Brazilian Portuguese when no locale is configured', () => {
    delete process.env.DEFAULT_LOCALE
    jest.resetModules()

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_LOCALE } = require('../../src/defaults')

    expect(DEFAULT_LOCALE).toBe('pt_BR')
  })

  test('preserves an explicitly configured locale', () => {
    process.env.DEFAULT_LOCALE = 'en'
    jest.resetModules()

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_LOCALE } = require('../../src/defaults')

    expect(DEFAULT_LOCALE).toBe('en')
  })
})

describe('removed global environment settings', () => {
  test('are not exposed as global defaults', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const defaults = require('../../src/defaults')
    const removedSettings = [
      'WEBHOOK_FORWARD_PHONE_NUMBER_ID',
      'WEBHOOK_FORWARD_BUSINESS_ACCOUNT_ID',
      'WEBHOOK_FORWARD_TOKEN',
      'WEBHOOK_FORWARD_VERSION',
      'WEBHOOK_FORWARD_URL',
      'WEBHOOK_FORWARD_TIMEOUT_MS',
      'WEBHOOK_CB_LOCAL_CLEANUP_INTERVAL_MS',
      'RECEIPT_RETRY_ASSERT_COOLDOWN_MS',
      'RECEIPT_RETRY_ASSERT_MAX_TARGETS',
      'SELFHEAL_ASSERT_ON_DECRYPT',
      'PERIODIC_ASSERT_ENABLED',
      'PERIODIC_ASSERT_INTERVAL_MS',
      'PERIODIC_ASSERT_MAX_TARGETS',
      'PERIODIC_ASSERT_RECENT_WINDOW_MS',
      'PERIODIC_ASSERT_FORCE',
      'PERIODIC_ASSERT_INCLUDE_GROUPS',
      'ONE_TO_ONE_PREASSERT_ENABLED',
      'ONE_TO_ONE_PREASSERT_COOLDOWN_MS',
      'ONE_TO_ONE_PREASSERT_REDIS_TTL_SEC',
      'ONE_TO_ONE_ASSERT_PROBE_ENABLED',
      'ONE_TO_ONE_PREASSERT_PURGE_DEVICE_LIST',
      'SIGNAL_SESSION_PURGE_ENABLED',
      'SIGNAL_CACHE_SAFE_MODE',
      'DELIVERY_WATCHDOG_ENABLED',
      'DELIVERY_WATCHDOG_MS',
      'DELIVERY_WATCHDOG_MAX_ATTEMPTS',
      'DELIVERY_WATCHDOG_GROUPS',
      'ONE_TO_ONE_ADDRESSING_MODE',
      'LID_RESOLVER_ENABLED',
      'LID_RESOLVER_BACKOFF_MS',
      'LID_RESOLVER_SWEEP_INTERVAL_MS',
      'LID_RESOLVER_MAX_PENDING',
      'DELIVERY_STALE_RECOVERY_ENABLED',
      'DELIVERY_STALE_RECOVERY_MS',
      'DELIVERY_STALE_RECOVERY_SCAN_MS',
      'DELIVERY_STALE_RECOVERY_MAX_ATTEMPTS',
      'DELIVERY_STALE_RECOVERY_MAX_PENDING',
      'DELIVERY_STALE_RECOVERY_BATCH_SIZE',
      'DELIVERY_STALE_RECOVERY_GROUPS',
      'GROUP_SEND_MEMBERSHIP_CHECK',
      'GROUP_SEND_ADDRESSING_MODE',
      'GROUP_SEND_PREASSERT_SESSIONS',
      'GROUP_SEND_FALLBACK_ORDER',
      'GROUP_LARGE_THRESHOLD',
      'GROUP_ASSERT_CHUNK_SIZE',
      'GROUP_ASSERT_FLOOD_WINDOW_MS',
      'VALIDATE_MEDIA_LINK_BEFORE_SEND',
      'AUTH_CACHE_TTL_MS',
      'AUTH_INDEX_FALLBACK_SCAN_LIMIT',
      'AUTH_SIGNAL_PRUNE_DEFAULT_TYPES',
      'AUTH_SIGNAL_PRUNE_MAX_DELETE',
      'AUTH_SIGNAL_PRUNE_PREKEY_KEEP_RECENT',
      'AUTH_SIGNAL_PRUNE_SCAN_COUNT',
      'AUTH_SIGNAL_PRUNE_BOOTSTRAP_ENABLED',
      'AUTH_SIGNAL_PRUNE_DAILY_ENABLED',
      'AUTH_SIGNAL_PRUNE_DAILY_INTERVAL_MS',
      'AUTH_SIGNAL_PRUNE_SESSION_INTERVAL_MS',
      'AUTH_SIGNAL_PRUNE_SESSION_LIMIT',
      'CONNECTING_TIMEOUT_MS',
      'BAILEYS_IDLE_RECONNECT_ENABLED',
      'BAILEYS_IDLE_RECONNECT_MS',
      'BAILEYS_IDLE_RECONNECT_CHECK_MS',
      'BAILEYS_CLEAR_APP_STATE_SYNC_ON_CONNECT',
      'BAILEYS_WAM_TELEMETRY',
      'BAILEYS_WAM_TELEMETRY_DEBUG_EVENTS',
      'BAILEYS_WAM_TELEMETRY_FLUSH_MS',
      'BAILEYS_WAM_TELEMETRY_MAX_EVENTS',
      'RELOAD_BAILEYS_DEBOUNCE_MS',
      'UNOAPI_DELAY_BETWEEN_MESSAGES_MS',
      'UNOAPI_DELAY_AFTER_FIRST_MESSAGE_MS',
      'IGNORE_CALLS',
      'SIGNAL_PURGE_DEVICE_LIST_ENABLED',
      'SIGNAL_PURGE_SESSION_ENABLED',
      'SIGNAL_PURGE_SENDER_KEY_ENABLED',
      'CONFIG_SESSION_PHONE_CLIENT',
      'CONFIG_SESSION_PHONE_NAME',
      'WHATSAPP_VERSION',
      'BAILEYS_COUNTRY_CODE',
      'DEFAULT_BROWSER',
      'QR_TIMEOUT_MS',
      'QR_POST_LOGIN_SUPPRESS_MS',
      'VALIDATE_SESSION_NUMBER',
      'BAILEYS_ALLOW_FULL_HISTORY_SYNC',
      'GROUP_METADATA_EVENT_REFRESH_ENABLED',
      'GROUP_METADATA_EVENT_REFRESH_DEBOUNCE_MS',
      'GROUP_METADATA_EVENT_REFRESH_MIN_INTERVAL_MS',
      'NO_SESSION_RETRY_BASE_DELAY_MS',
      'NO_SESSION_RETRY_PER_200_DELAY_MS',
      'NO_SESSION_RETRY_MAX_DELAY_MS',
      'INBOUND_DEDUP_WINDOW_MS',
      'BR_SEND_ORDER_ENABLED',
      'JIDMAP_ENRICH_ENABLED',
      'JIDMAP_ENRICH_PER_SWEEP',
      'JIDMAP_ENRICH_AUTH_ENABLED',
      'JIDMAP_ENRICH_ON_STORE_ENABLED',
      'WATCHDOG_PURGE_SCAN_COUNT',
      'WATCHDOG_TASK_MIN_INTERVAL_MS',
      'JIDMAP_ENRICH_MIN_INTERVAL_MS',
      'ACK_RETRY_DELAYS_MS',
      'ACK_RETRY_MAX_ATTEMPTS',
      'ACK_RETRY_ENABLED',
      'MEDIA_RETRY_ENABLED',
      'MEDIA_RETRY_DELAYS_MS',
      'COEXISTENCE_ENABLED',
      'COEXISTENCE_WINDOW_SECONDS',
    ]

    removedSettings.forEach((setting) => expect(defaults).not.toHaveProperty(setting))
  })
})

describe('consumer timeout', () => {
  const previousTimeout = process.env.CONSUMER_TIMEOUT_MS

  afterEach(() => {
    if (typeof previousTimeout === 'undefined') delete process.env.CONSUMER_TIMEOUT_MS
    else process.env.CONSUMER_TIMEOUT_MS = previousTimeout
    jest.resetModules()
  })

  test('allows long session webhook timeouts by default', () => {
    delete process.env.CONSUMER_TIMEOUT_MS
    jest.resetModules()

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CONSUMER_TIMEOUT_MS } = require('../../src/defaults')

    expect(CONSUMER_TIMEOUT_MS).toBe(450000)
  })
})

describe('credential defaults', () => {
  const previousWebhookToken = process.env.WEBHOOK_TOKEN
  const previousAuthToken = process.env.UNOAPI_AUTH_TOKEN
  const previousStorageSecret = process.env.STORAGE_SECRET_ACCESS_KEY

  afterEach(() => {
    if (typeof previousWebhookToken === 'undefined') delete process.env.WEBHOOK_TOKEN
    else process.env.WEBHOOK_TOKEN = previousWebhookToken
    if (typeof previousAuthToken === 'undefined') delete process.env.UNOAPI_AUTH_TOKEN
    else process.env.UNOAPI_AUTH_TOKEN = previousAuthToken
    if (typeof previousStorageSecret === 'undefined') delete process.env.STORAGE_SECRET_ACCESS_KEY
    else process.env.STORAGE_SECRET_ACCESS_KEY = previousStorageSecret
    jest.resetModules()
  })

  test('does not provide hardcoded webhook or storage secrets', () => {
    delete process.env.WEBHOOK_TOKEN
    delete process.env.UNOAPI_AUTH_TOKEN
    delete process.env.STORAGE_SECRET_ACCESS_KEY
    jest.resetModules()

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const defaults = require('../../src/defaults')

    expect(defaults.WEBHOOK_TOKEN).toBe('')
    expect(defaults.STORAGE_SECRET_ACCESS_KEY).toBe('')
  })
})
describe('API error language', () => {
  const previous = process.env.UNOAPI_API_LANGUAGE
  afterEach(() => {
    if (previous === undefined) delete process.env.UNOAPI_API_LANGUAGE
    else process.env.UNOAPI_API_LANGUAGE = previous
    jest.resetModules()
  })
  test.each([[undefined, 'pt-BR'], ['pt-BR', 'pt-BR'], ['en', 'en'], ['en-US', 'en'], ['invalid', 'pt-BR']])('loads %s as %s', (input, expected) => {
    if (input === undefined) delete process.env.UNOAPI_API_LANGUAGE
    else process.env.UNOAPI_API_LANGUAGE = input
    jest.resetModules()
    expect(require('../../src/defaults').UNOAPI_API_LANGUAGE).toBe(expected)
  })
})
