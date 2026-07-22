import type { Contact, ContactResponse } from './contact'
import type { Incoming } from './incoming'

export class ContactIncoming implements Contact {
  constructor(private readonly incoming: Incoming) {}

  async verify(phone: string, numbers: string[], webhook?: string): Promise<ContactResponse> {
    if (typeof this.incoming.contacts !== 'function') {
      throw new Error('Incoming provider does not support contact verification')
    }
    const contacts = await this.incoming.contacts(phone, numbers)
    if (webhook) await this.notify(webhook, contacts)
    return { contacts }
  }

  private async notify(webhook: string, contacts: ContactResponse['contacts']) {
    const response = await fetch(webhook, {
      method: 'POST',
      body: JSON.stringify({ contacts }),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    if (!response.ok) throw new Error(await response.text())
  }
}
