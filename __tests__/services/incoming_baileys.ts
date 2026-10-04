import { IncomingBaileys } from '../../src/services/incoming_baileys'
import { Incoming } from '../../src/services/incoming'
import { Listener } from '../../src/services/listener'
import { getClient, Client, Contact } from '../../src/services/client'
import { Config, defaultConfig, getConfig, getConfigDefault } from '../../src/services/config'
import { mock } from 'jest-mock-extended'
import logger from '../../src/services/logger'
import type { SaveContactInput } from '../../src/services/contacts/contact_book_types'

class DummyClient implements Client {
  phone: string
  config: Config

  constructor() {
    this.phone = `${new Date().getTime()}`
    this.config = defaultConfig
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async connect(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async disconnect(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async logout(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  async send(payload: any): Promise<any> {
    return true
  }
  async getMessageMetadata<T>(data: T) {
    return data
  }

  public async contacts(_numbers: string[]) {
    const contacts: Contact[] = []
    return contacts
  }

  public async saveContact(input: SaveContactInput) {
    return {
      success: true as const,
      contact: {
        phone_number: input.phone_number,
        full_name: input.full_name,
        first_name: input.first_name || input.full_name.split(' ')[0],
        user_id: input.user_id || '123@lid',
      },
    }
  }
}

const dummyClient = new DummyClient()

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getClientDummy: getClient = async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  phone,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  listener,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getConfig,
}: {
  phone: string
  listener: Listener
  getConfig: getConfig
}): Promise<Client> => {
  return dummyClient
}

const onNewLogin = async (phone: string) => {
  logger.info('New login %s', phone)
}

describe('service incoming baileys', () => {
  test('own profile delegates to selected client or fails capability explicitly', async () => {
    const client: any = { ownProfile: jest.fn().mockResolvedValue({ success: true }) }
    const getClient = jest.fn().mockResolvedValue(client)
    const incoming = new IncomingBaileys(mock<Listener>(), getConfigDefault, getClient, onNewLogin)
    const command = { action: 'set' as const, field: 'name' as const, value: 'Nome' }
    expect(await incoming.ownProfile('5511999999999', command)).toEqual({ success: true })
    expect(client.ownProfile).toHaveBeenCalledWith(command)
    delete client.ownProfile
    await expect(incoming.ownProfile('5511999999999', command)).rejects.toThrow('own_profile_capability_unavailable')
  })
  test('send', async () => {
    const phone = `${new Date().getTime()}`
    const service: Listener = mock<Listener>()
    const baileys: Incoming = new IncomingBaileys(service, getConfigDefault, getClientDummy, onNewLogin)
    const payload: object = { humm: new Date().getTime() }
    const send = jest.spyOn(dummyClient, 'send')
    await baileys.send(phone, payload, {})
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(payload, {})
  })

  test('delegates address-book contact creation to the client', async () => {
    const service: Listener = mock<Listener>()
    const incoming = new IncomingBaileys(service, getConfigDefault, getClientDummy, onNewLogin)
    const input = { phone_number: '5511988887777', full_name: 'Maria Silva' }
    const saveContact = jest.spyOn(dummyClient, 'saveContact')

    await incoming.saveContact!('5566', input)

    expect(saveContact).toHaveBeenCalledWith(input)
  })
})
