import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'

const read = (name: string) => YAML.parse(fs.readFileSync(`docs/examples/${name}`, 'utf8'), { merge: true })

describe('VoIP broker and optional RustFS deployment examples', () => {
  test.each(['nginx', 'traefik'])('Compose %s exposes only loopback AMQP for host-networked VoIP', (proxy) => {
    const model = read(`docker-compose.unoapi-${proxy}.yml`)
    const rabbit = model.services['unoapi-rabbitmq']
    const voip = model.services['viperconnect-telefonia']
    expect(voip.network_mode).toBe('host')
    expect(rabbit.ports).toEqual(['127.0.0.1:5672:5672'])
    const url = new URL(voip.environment.AMQP_URL)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe('5672')
    expect(url.username).toBe(rabbit.environment.RABBITMQ_DEFAULT_USER)
    expect(url.password).toBe(rabbit.environment.RABBITMQ_DEFAULT_PASS)
  })

  test.each(['nginx', 'traefik'])('Swarm %s uses overlay DNS without exposing AMQP', (proxy) => {
    const model = read(`docker-stack.unoapi-${proxy}.yml`)
    expect(model.services['viperconnect-telefonia'].environment.AMQP_URL).toBe(model['x-base-environment'].AMQP_URL)
    expect(new URL(model.services['viperconnect-telefonia'].environment.AMQP_URL).hostname).toBe('unoapi-rabbitmq')
    expect(model.services['unoapi-rabbitmq'].ports).toBeUndefined()
  })

  test('RustFS add-ons pin the image, retain volumes and do not redirect existing S3 configuration', () => {
    for (const kind of ['compose', 'stack']) {
      const model = read(`docker-${kind}.rustfs.yml`)
      expect(Object.keys(model.services)).toEqual(['rustfs'])
      const service = model.services.rustfs
      expect(service.image).toBe('rustfs/rustfs:1.0.3')
      expect(service.volumes).toEqual(['rustfs-data:/data', 'rustfs-logs:/logs'])
      expect(service.command).toEqual(['/data'])
      expect(service.healthcheck.test).toContain('http://127.0.0.1:9000/health/ready')
      expect(service.environment.RUSTFS_ACCESS_KEY).not.toBe('rustfsadmin')
      expect(service.environment.RUSTFS_SECRET_KEY).not.toBe('rustfsadmin')
      expect(service.environment.STORAGE_ENDPOINT).toBeUndefined()
      expect(model['x-base-environment']).toBeUndefined()
      expect(Object.keys(model.volumes)).toEqual(['rustfs-data', 'rustfs-logs'])
    }
    expect(read('docker-compose.rustfs.yml').services.rustfs.ports)
      .toEqual(['127.0.0.1:9000:9000', '127.0.0.1:9001:9001'])
    const swarm = read('docker-stack.rustfs.yml').services.rustfs
    expect(swarm.deploy.replicas).toBe(1)
    expect(swarm.deploy.placement.constraints).toContain('node.labels.viperconnect.data == true')
    expect(swarm.environment.RUSTFS_CONSOLE_ENABLE).toBe('false')
    expect(swarm.ports).toEqual([{ target: 9000, published: 9000, protocol: 'tcp', mode: 'host' }])
  })

  test.each(['compose', 'stack'])('%s Traefik routes only the S3 API', (kind) => {
    const service = read(`docker-${kind}.rustfs-traefik.yml`).services.rustfs
    const labels = kind === 'compose' ? service.labels : service.deploy.labels
    expect(labels).toContain('traefik.http.services.unoapi-s3.loadbalancer.server.port=9000')
    expect(labels.join(' ')).not.toContain('9001')
    expect(labels).toContain(`traefik.${kind === 'compose' ? 'docker' : 'swarm'}.network=traefik-public`)
  })

  test('public storage downloads match their canonical sources', () => {
    for (const kind of ['compose', 'stack']) for (const suffix of ['', '-traefik']) {
      const name = `docker-${kind}.rustfs${suffix}.yml`
      const canonical = fs.readFileSync(`docs/examples/${name}`, 'utf8').replace(/\r\n/g, '\n')
      expect(fs.readFileSync(`docs-site/public/examples/${name}`, 'utf8').replace(/\r\n/g, '\n')).toBe(canonical)
    }
  })

  test('single-file Portainer models retain anchors and all application roles', () => {
    for (const kind of ['compose', 'stack']) for (const proxy of ['nginx', 'traefik']) {
      const name = `docker-${kind}.unoapi-${proxy}-rustfs.yml`
      const text = fs.readFileSync(`docs/examples/${name}`, 'utf8')
      const model = YAML.parse(text, { merge: true })
      expect(text).toContain('&base')
      expect(text).toContain('&base-environment')
      expect(text).not.toMatch(/&id\d+/)
      expect(Object.keys(model.services)).toHaveLength(8)
      expect(model.services.rustfs.image).toBe('rustfs/rustfs:1.0.3')
      expect(model.services['unoapi-video-worker'].environment.UNOAPI_PROCESS_ROLE).toBe('video')
      expect(model.services['unoapi-worker-zapo'].environment.UNOAPI_PROCESS_ROLE).toBe('worker')
      expect(model.services['viperconnect-telefonia'].environment.AMQP_URL).toBeTruthy()
      expect(model.volumes).toHaveProperty('rustfs-data')
      expect(fs.readFileSync(`docs-site/public/examples/${name}`, 'utf8').replace(/\r\n/g, '\n')).toBe(text.replace(/\r\n/g, '\n'))
    }
  })

  test('S3 smoke script refuses public endpoints and requires explicit opt-in', () => {
    const script = `import { validateSmokeEndpoint } from './scripts/smoke-rustfs-s3.mjs';
      const env = { RUSTFS_SMOKE_ENABLED: '1', RUSTFS_SMOKE_ACCESS_KEY: 'fixture', RUSTFS_SMOKE_SECRET_KEY: 'fixture' };
      for (const endpoint of ['https://127.0.0.1', 'http://s3.example.com', 'http://127.0.0.1/path', 'http://user:pass@127.0.0.1']) {
        let rejected = false; try { validateSmokeEndpoint({ ...env, RUSTFS_SMOKE_ENDPOINT: endpoint }) } catch { rejected = true }
        if (!rejected) throw Error('unsafe_endpoint_accepted');
      }
      let rejected = false; try { validateSmokeEndpoint({ ...env, RUSTFS_SMOKE_ENABLED: '', RUSTFS_SMOKE_ENDPOINT: 'http://127.0.0.1:9000' }) } catch { rejected = true }
      if (!rejected) throw Error('opt_in_missing');
      if (validateSmokeEndpoint({ ...env, RUSTFS_SMOKE_ENDPOINT: 'http://127.0.0.1:9000' }) !== 'http://127.0.0.1:9000') throw Error('fixture_rejected');`
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow()
  })
})
