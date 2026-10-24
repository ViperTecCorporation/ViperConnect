import fs from 'fs'
import path from 'path'
import YAML from 'yaml'

describe('Zapo-only runtime artifacts', () => {
  test('compiles the cloud entry graph instead of every legacy entrypoint', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve('tsconfig.runtime.json'), 'utf8'))
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    const cloudEntry = fs.readFileSync(path.resolve('src/cloud.ts'), 'utf8')

    expect(config.include).toEqual(['src/cloud.ts'])
    expect(pkg.scripts.build).toContain('-p tsconfig.runtime.json')
    expect(pkg.scripts.build).toContain('check-zapo-runtime-graph.mjs')
    expect(pkg.scripts.start).toContain('dist/src/cloud.js')
    expect(cloudEntry).toContain("role === 'broker'")
    expect(cloudEntry).toContain("import('./bulker.js')")
    expect(pkg.scripts['start-ts']).toBeUndefined()
    expect(pkg.scripts.standalone).toBeUndefined()
    expect(pkg.scripts['standalone-dev']).toBeUndefined()
    expect(pkg.scripts['standalone-ts']).toBeUndefined()
    expect(pkg.scripts.web).toBeUndefined()
    expect(pkg.scripts.worker).toBeUndefined()
    expect(pkg.scripts.broker).toBeUndefined()
    expect(pkg.scripts.bridge).toBeUndefined()
    expect(pkg.exports).toBeUndefined()
    expect(pkg.types).toBeUndefined()
    expect(pkg.dependencies['@whiskeysockets/baileys']).toBeUndefined()
    expect(pkg.dependencies['file-type']).toBe('21.3.4')
    expect(pkg.devDependencies['@whiskeysockets/baileys']).toContain('ViperTecCorporation/Baileys')
  })

  test('uses production-only dependencies in the default Docker target', () => {
    const dockerfile = fs.readFileSync(path.resolve('Dockerfile'), 'utf8')
    const compose = YAML.parse(fs.readFileSync(path.resolve('docker-compose.yml'), 'utf8'))

    const entrypoints = [...dockerfile.matchAll(/^ENTRYPOINT\s+(\[[^\r\n]+\])/gm)]
      .map((match) => JSON.parse(match[1]))
    expect(entrypoints).toEqual([
      ['/home/u/app/container-entrypoint.sh'],
      ['/home/u/app/container-entrypoint.sh'],
    ])
    expect(dockerfile).toContain('COPY --from=voip-builder /app/dist ./voip/dist')
    expect(dockerfile).toContain('FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS builder')
    expect(dockerfile).toContain('AS production-dependencies')
    expect(dockerfile).toContain('yarn install --production --frozen-lockfile')
    expect(dockerfile).toContain("await import('file-type')")
    expect(dockerfile).toContain('FROM runtime-base AS legacy-runtime')
    expect(dockerfile).toContain('FROM runtime-base AS runtime')
    expect(dockerfile).toContain('COPY --from=production-dependencies /app/node_modules ./node_modules')
    expect(dockerfile).toMatch(/apt-get install[^\n]+ffmpeg qpdf wget/)
    expect(compose.services['worker-zapo'].environment.UNOAPI_WORKER_ENGINE).toBe('zapo')
    expect(compose.services.voip.environment.UNOAPI_PROCESS_ROLE).toBe('voip')
    expect(compose.services.voip.image).toBe('ghcr.io/viperteccorporation/viperconnect:latest')
    expect(compose.services['worker-baileys']).toBeUndefined()
  })

  test('documents the cloud entrypoint without overriding it in production examples', () => {
    const architecture = fs.readFileSync(path.resolve('docs/CLOUD_ARCHITECTURE.md'), 'utf8')
    const nginx = YAML.parse(fs.readFileSync(path.resolve('docs/examples/docker-compose.unoapi-nginx.yml'), 'utf8'))
    const traefik = YAML.parse(fs.readFileSync(path.resolve('docs/examples/docker-compose.unoapi-traefik.yml'), 'utf8'))

    expect(architecture).toContain('node dist/src/cloud.js')
    expect(architecture).toContain('Quando `UNOAPI_PROCESS_ROLE` está ausente ou vazio')
    expect(architecture).toContain('consumidores de campanhas, comandos e status em lote')
    expect(nginx.services.unoapi.entrypoint).toBeUndefined()
    expect(traefik.services.unoapi.entrypoint).toBeUndefined()
  })
})
