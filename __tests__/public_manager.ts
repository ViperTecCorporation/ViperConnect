import fs from 'fs'
import path from 'path'

describe('public session manager', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8')

  test('does not expose Cloud Embedded Signup or coexistence configuration', () => {
    expect(html).not.toContain('Cloud / Embedded Signup')
    expect(html).not.toContain('webhookForwardPhoneNumberId')
    expect(html).not.toContain('webhookForwardToken')
    expect(html).not.toContain('webhookForwardBusinessAccountId')
    expect(html).not.toContain('coexistenceEnabled')
    expect(html).not.toContain('/embedded/config.js')
    expect(html).not.toContain('oneToOneAddressingMode')
    expect(html).not.toContain('applyEmbeddedToForm')
  })

  test('does not overwrite hidden Cloud settings when saving a session', () => {
    expect(html).not.toMatch(/webhookForward\s*:/)
    expect(html).not.toMatch(/coexistenceWindowSeconds\s*:/)
  })
})
