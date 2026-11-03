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
})
