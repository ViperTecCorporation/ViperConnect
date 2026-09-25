import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** Versioned AEAD; associated data prevents copying a record to another draft. */
export class RegistrationVault {
  private readonly key: Buffer
  constructor(secret: string) {
    if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('mobile_registration_key_required')
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), 'uno-mobile-registration-v1', 32))
  }
  seal(id: string, value: unknown): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(id))
    const payload = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), payload.toString('base64')].join('.')
  }
  open<T>(id: string, envelope: string): T {
    try {
      if (envelope.length > 262144) throw new Error()
      const [version, iv, tag, payload, extra] = envelope.split('.')
      if (version !== 'v1' || extra !== undefined) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8'))
    } catch { throw new Error('mobile_registration_state_unreadable') }
  }
}
