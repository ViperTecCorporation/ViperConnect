import { version as packageVersion } from '../../package.json'
import {
  compareVersions,
  newestVersionTag,
  readInstalledVersion,
  VersionStatusService,
} from '../../src/services/version_status'

describe('version status', () => {
  test('reads the installed version from the project manifest', () => {
    expect(readInstalledVersion()).toBe(packageVersion)
  })

  test('compares stable and prerelease tags naturally', () => {
    expect(compareVersions('v4.0.0-beta10', '4.0.0-beta9')).toBeGreaterThan(0)
    expect(compareVersions('4.0.0', '4.0.0-beta10')).toBeGreaterThan(0)
    expect(compareVersions('5.0.0-beta', '4.9.9')).toBeGreaterThan(0)
    expect(newestVersionTag([
      { name: 'invalid' },
      { name: 'v4.0.0-beta7' },
      { name: 'v4.0.0-beta8' },
    ])).toBe('v4.0.0-beta8')
  })

  test('reports an available update and caches the GitHub response', async () => {
    let now = Date.parse('2026-07-25T12:00:00.000Z')
    const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify([
      { name: 'v4.0.0-beta8' },
      { name: 'v4.0.0-beta7' },
    ]), { status: 200 }))
    const service = new VersionStatusService('4.0.0-beta7', fetcher, () => now)

    await expect(service.get()).resolves.toMatchObject({
      installed_version: '4.0.0-beta7',
      latest_version: '4.0.0-beta8',
      update_available: true,
      status: 'update_available',
    })
    await service.get()
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += 16 * 60 * 1000
    await service.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('keeps the installed version visible when GitHub is unavailable', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response('', { status: 503 }))
    const service = new VersionStatusService('4.0.0-beta7', fetcher)

    await expect(service.get()).resolves.toMatchObject({
      installed_version: '4.0.0-beta7',
      update_available: false,
      status: 'unknown',
    })
  })
})
