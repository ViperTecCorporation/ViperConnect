import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Linux container entrypoint', () => {
  test('keeps the shell script in LF with the expected interpreter and role dispatch', () => {
    const script = readFileSync(resolve(__dirname, '../../scripts/container-entrypoint.sh'))
    expect(script.includes(13)).toBe(false)
    expect(script.toString().startsWith('#!/bin/sh\n')).toBe(true)
    expect(script.toString()).toContain('cd /home/u/app/voip')
    expect(script.toString()).toContain('exec node dist/app.js "$@"')
    expect(script.toString()).toContain('exec node /home/u/app/dist/src/cloud.js "$@"')
  })

  test('pins checkout line endings and normalizes and validates the Linux image', () => {
    const attributes = readFileSync(resolve(__dirname, '../../.gitattributes'), 'utf8')
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8')
    expect(attributes).toContain('/scripts/container-entrypoint.sh text eol=lf')
    expect(dockerfile).toContain("sed -i 's/\\r$//' container-entrypoint.sh")
    expect(dockerfile).toContain('invalid_entrypoint_line_endings')
    expect(dockerfile.match(/ENTRYPOINT \["\/home\/u\/app\/container-entrypoint.sh"\]/g)).toHaveLength(2)
  })

  test('prepares the default session volume for the unprivileged runtime before Docker initializes new volumes', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8')
    expect(dockerfile).toContain('mkdir -p data/medias data/sessions data/stores data/logs voip/data /home/u/app/session-data')
    expect(dockerfile).toContain('chmod 0700 /home/u/app/session-data')
    expect(dockerfile.indexOf('mkdir -p data/medias')).toBeLessThan(dockerfile.indexOf('chown -R u:u /home/u/app'))
    expect(dockerfile.match(/USER u\r?\nRUN test -w \/home\/u\/app\/session-data/g)).toHaveLength(2)
    expect(dockerfile).not.toContain('chmod 777')
  })
})
