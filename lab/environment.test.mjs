import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnvironment, initializeEnvironment } from './environment.mjs'
import YAML from 'yaml'

const storage = { STORAGE_ENDPOINT: 'https://s3.example.test', STORAGE_ACCESS_KEY_ID: 'test', STORAGE_SECRET_ACCESS_KEY: 'test$secret', STORAGE_BUCKET_NAME: 'production', UNOAPI_AUTH_TOKEN: 'production-token' }

test('normal admin port overlay adds only a loopback alias to the same lab web service', async () => {
  const base = YAML.parse(await readFile(new URL('../compose.lab.yml', import.meta.url), 'utf8'), { merge: true })
  const overlay = YAML.parse(await readFile(new URL('../compose.lab.admin-port.yml', import.meta.url), 'utf8'))
  assert.deepEqual(overlay, { services: { web: { ports: ['127.0.0.1:9876:9876'] } } })
  assert.deepEqual(base.services.web.ports, ['127.0.0.1:19876:9876'])
  assert.equal(base.services['worker-zapo'].environment.UNOAPI_STORAGE_SYNTHETIC_ONLY, '${LAB_STORAGE_SYNTHETIC_ONLY:-true}')
  assert.ok(base.services['worker-zapo'].volumes.includes('session-data:/app/session-data'))
})
test('lab app builds, tests and includes the executable native media relay', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /CGO_ENABLED=0 go test \.\/\.\.\./)
  assert.match(dockerfile, /GOOS=\$TARGETOS GOARCH=\$TARGETARCH go build/)
  const app = dockerfile.split('FROM base AS app')[1].split('FROM base AS docs')[0]
  assert.match(app, /COPY --from=relay-bridge-builder --chmod=0755 \/out\/relay-bridge \/app\/vendor\/zapo-voip\/native\/relay-bridge\/relay-bridge/)
  assert.match(app, /ENV ZAPO_VOIP_RELAY_BRIDGE_PATH=\/app\/vendor\/zapo-voip\/native\/relay-bridge\/relay-bridge/)
  assert.match(app, /RUN "\$ZAPO_VOIP_RELAY_BRIDGE_PATH" -h/)
})
test('only storage configuration is inherited; tokens are fresh and secrets stay literal', () => {
  const result = createEnvironment(storage)
  assert.match(result, /LAB_STORAGE_SECRET_ACCESS_KEY='test\$secret'/)
  assert.doesNotMatch(result, /production/)
  assert.notEqual(result, createEnvironment(storage))
})
test('rejects missing keys, plaintext endpoints, credentials in URLs and env injection', () => {
  for (const input of [{}, { ...storage, STORAGE_ENDPOINT: 'http://s3.test' }, { ...storage, STORAGE_ENDPOINT: 'https://user:pass@s3.test' }, { ...storage, STORAGE_SECRET_ACCESS_KEY: 'a\nB=c' }, { ...storage, STORAGE_REGION: "a'b" }]) {
    assert.throws(() => createEnvironment(input))
  }
})
test('initialization never overwrites an existing environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'viperconnect-lab-test-'))
  try {
    const destination = join(directory, 'lab.env')
    await initializeEnvironment(storage, destination)
    const before = await readFile(destination, 'utf8')
    await assert.rejects(initializeEnvironment(storage, destination), { code: 'EEXIST' })
    assert.equal(await readFile(destination, 'utf8'), before)
  } finally {
    await rm(directory, { recursive: true })
  }
})
test('compose isolates production, storage and host exposure', async () => {
  const compose = YAML.parse(await readFile(new URL('../compose.lab.yml', import.meta.url), 'utf8'), { merge: true })
  assert.equal(compose.name, 'viperconnect-mobile-lab')
  for (const role of ['web', 'broker', 'worker-zapo', 'video-worker']) {
    const service = compose.services[role]
    assert.equal(service.environment.STORAGE_BUCKET_NAME, 'viperconnect-lab')
    assert.equal(service.environment.REDIS_URL, 'redis://redis:6379')
    assert.match(service.environment.AMQP_URL, /@rabbitmq:5672$/)
    assert.equal(service.environment.AUTO_CONNECT, 'false')
    assert.equal(service.environment.WEBHOOK_URL, '')
    assert.equal(service.environment.VOIP_SERVICE_URL, '')
    assert.equal(service.env_file, undefined)
    assert.ok(service.volumes.includes('compiled:/app/dist:ro'))
  }
  for (const service of Object.values(compose.services)) {
    assert.equal(service.network_mode, undefined)
    for (const port of service.ports || []) assert.ok(port.startsWith('127.0.0.1:'))
    for (const volume of service.volumes || []) assert.ok(!volume.startsWith('./:/'))
  }
  for (const volume of Object.values(compose.volumes)) assert.equal(volume.external, undefined)
  assert.equal(compose.services.redis.ports, undefined)
  const command = compose.services.compiler.command
  assert.equal(command[command.indexOf('--ext') + 1], 'ts,json,css,html,svg,cjs,mjs')
})

test('optional VoIP overlay stays local with its own database and authenticated bridge', async () => {
  const compose = YAML.parse(await readFile(new URL('../compose.lab.voip.yml', import.meta.url), 'utf8'), { merge: true })
  assert.equal(compose.services['worker-zapo'].environment.VOIP_BRIDGE_URL, 'ws://voip:3097/v1/bridge/zapo')
  assert.equal(compose.services.web.environment.VOIP_SERVICE_URL, 'http://voip:3097')
  assert.match(compose.services.voip.environment.VOIP_SERVICE_TOKEN, /LAB_VOIP_SERVICE_TOKEN/)
  const amqp = compose.services.voip.environment.AMQP_URL
  assert.match(amqp, /^amqp:\/\/lab:\$\{LAB_RABBIT_PASSWORD:.*\}@rabbitmq:5672$/)
  assert.equal(compose.services.voip.environment.VOIP_AMQP_URL, amqp)
  assert.deepEqual(compose.services.voip.volumes, ['voip-data:/home/u/app/data'])
  const allowedSipLanPorts = new Set(['0.0.0.0:5060:5060/udp', '0.0.0.0:12000-12063:12000-12063/udp'])
  for (const service of Object.values(compose.services)) {
    assert.equal(service.network_mode, undefined)
    for (const port of service.ports || []) {
      if (allowedSipLanPorts.has(port)) assert.equal(service, compose.services.voip)
      else assert.match(port, /^127\.0\.0\.1:/)
    }
    for (const value of Object.values(service.environment || {})) assert.doesNotMatch(String(value), /192\.168\.0\.50|sip\.vipertec\.net|45\.224\.94\.232/)
  }
  assert.match(compose.services.coturn.command[0], /--lt-cred-mech/)
  assert.equal(compose.volumes['voip-data'].external, undefined)
})

test('lab launcher preserves VoIP, admin port and persistent storage tool overlays together', async () => {
  const launcher = await readFile(new URL('./lab.ps1', import.meta.url), 'utf8')
  assert.match(launcher, /Test-Path -LiteralPath \$labVoipEnv/)
  assert.match(launcher, /'compose\.lab\.voip\.yml'/)
  assert.match(launcher, /foreach \(\$labOverlay in @\('compose\.lab\.admin-port\.yml', 'compose\.lab\.storage-tools\.yml'\)\)/)
  assert.match(launcher, /Test-Path -LiteralPath \$labOverlayPath/)
})

test('VoIP smoke resolves WebRTC in both current and legacy image layouts', async () => {
  const smoke = await readFile(new URL('./voip-smoke.cjs', import.meta.url), 'utf8')
  assert.match(smoke, /require\.resolve\('@roamhq\/wrtc'/)
  assert.match(smoke, /paths: \[process\.cwd\(\), '\/home\/u\/app', '\/home\/u\/app\/voip'\]/)
})

test('container TURN smoke uses coturn for host loopback without changing other servers', async () => {
  const smoke = await readFile(new URL('./voip-smoke.cjs', import.meta.url), 'utf8')
  const expression = smoke.match(/const turnUrl = (.+)/)?.[1]
  assert.ok(expression)
  const resolve = new Function('process', `return (${expression})`)
  for (const [input, expected] of [
    ['turn:127.0.0.1:3478', 'turn:coturn:3478'],
    ['turn:localhost:3478?transport=tcp', 'turn:coturn:3478?transport=tcp'],
    ['turns:localhost:5349', 'turns:coturn:5349'],
    ['turn:turn.example.test:3478', 'turn:turn.example.test:3478'],
    ['turn:localhost.example.test:3478', 'turn:localhost.example.test:3478'],
  ]) assert.equal(resolve({ env: { VOIP_TURN_URL: input } }), expected)
})
