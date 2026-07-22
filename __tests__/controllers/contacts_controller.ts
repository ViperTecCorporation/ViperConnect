import { ContactsController } from '../../src/controllers/contacts_controller'
import type { Contact } from '../../src/services/contact'
import type { ContactDirectory } from '../../src/services/contacts/contact_directory_types'
import { SendError } from '../../src/services/send_error'

const response = () => {
  const res = {
    status: jest.fn(),
    send: jest.fn(),
  }
  res.status.mockReturnValue(res)
  res.send.mockReturnValue(res)
  return res
}

describe('ContactsController directory', () => {
  const verifier = { verify: jest.fn() } as unknown as Contact

  test('returns the requested directory page', async () => {
    const page = { contacts: [], next_cursor: '0', has_more: false }
    const directory = { list: jest.fn().mockResolvedValue(page) } as unknown as ContactDirectory
    const controller = new ContactsController(verifier, directory)
    const res = response()

    await controller.get({ params: { phone: '5566' }, query: { cursor: '8', limit: '25' } } as never, res as never)

    expect(directory.list).toHaveBeenCalledWith('5566', { cursor: '8', limit: 25 })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith(page)
  })

  test.each([
    [{ limit: '0' }, 'limit_must_be_between_1_and_200'],
    [{ limit: '201' }, 'limit_must_be_between_1_and_200'],
    [{ cursor: 'next' }, 'cursor_must_be_numeric'],
  ])('rejects invalid pagination query %j', async (query, expectedError) => {
    const directory = { list: jest.fn() } as unknown as ContactDirectory
    const controller = new ContactsController(verifier, directory)
    const res = response()

    await controller.get({ params: { phone: '5566' }, query } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.send).toHaveBeenCalledWith({ error: expectedError })
    expect(directory.list).not.toHaveBeenCalled()
  })

  test('returns a conflict for a Baileys session', async () => {
    const directory = { list: jest.fn().mockRejectedValue(new SendError(409, 'contact_directory_requires_zapo_provider')) }
    const controller = new ContactsController(verifier, directory)
    const res = response()

    await controller.get({ params: { phone: '5566' }, query: {} } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.send).toHaveBeenCalledWith({ error: 'contact_directory_requires_zapo_provider' })
  })

  test('reports when no directory service was configured', async () => {
    const controller = new ContactsController(verifier)
    const res = response()

    await controller.get({ params: { phone: '5566' }, query: {} } as never, res as never)

    expect(res.status).toHaveBeenCalledWith(501)
  })
})
