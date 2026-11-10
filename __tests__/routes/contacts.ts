import express from 'express'
import request from 'supertest'
import { mock } from 'jest-mock-extended'
import { ContactsController } from '../../src/controllers/contacts_controller'
import type { Contact } from '../../src/services/contact'
import type { ContactDirectory } from '../../src/services/contacts/contact_directory_types'
import type { ContactBook } from '../../src/services/contacts/contact_book'

describe('contacts directory route', () => {
  test('serves the contact directory page through GET /:phone/contacts', async () => {
    const page = {
      contacts: [
        {
          user_id: '123@lid',
          phone_number: '5566999554300',
          push_name: 'Maria',
          last_updated_ms: 1710000000000,
        },
      ],
      next_cursor: '0',
      has_more: false,
      total_count: 1,
      raw_total_count: 1,
      ignored_count: 0,
    }
    const directory: ContactDirectory = {
      list: jest.fn().mockResolvedValue(page),
    }
    const controller = new ContactsController(mock<Contact>(), directory)
    const app = express()
    app.get('/:phone/contacts', controller.get.bind(controller))

    const response = await request(app).get('/5566/contacts?limit=20').expect(200)

    expect(directory.list).toHaveBeenCalledWith('5566', {
      cursor: undefined,
      limit: 20,
      search: undefined,
    })
    expect(response.body).toEqual(page)
  })

  test('rejects contact searches shorter than three characters', async () => {
    const directory: ContactDirectory = { list: jest.fn() }
    const controller = new ContactsController(mock<Contact>(), directory)
    const app = express()
    app.get('/:phone/contacts', controller.get.bind(controller))

    const response = await request(app).get('/5566/contacts?search=ma').expect(400)

    expect(response.body).toEqual({ error: 'search_must_have_at_least_3_characters' })
    expect(directory.list).not.toHaveBeenCalled()
  })

  test('returns a controlled 503 for RPC timeouts and keeps serving other requests', async () => {
    const directory: ContactDirectory = { list: jest.fn().mockRejectedValueOnce(new Error('timeout 450000 rpc private queue details'))
      .mockResolvedValueOnce({ contacts: [], next_cursor: '0', has_more: false, total_count: 0, raw_total_count: 0, ignored_count: 0 }) }
    const controller = new ContactsController(mock<Contact>(), directory)
    const app = express()
    app.get('/:phone/contacts', controller.get.bind(controller))
    app.get('/ping', (_req, res) => res.sendStatus(200))
    const response = await request(app).get('/5566/contacts').expect(503)
    expect(response.body).toEqual({ error: 'contact_directory_unavailable' })
    expect(JSON.stringify(response.body)).not.toContain('private queue')
    await request(app).get('/ping').expect(200)
    await request(app).get('/5566/contacts').expect(200)
  })

  test('saves a contact through POST /:phone/contacts/import', async () => {
    const contactBook: ContactBook = {
      save: jest.fn().mockResolvedValue({
        success: true,
        contact: {
          phone_number: '5511988887777',
          full_name: 'Maria Silva',
          first_name: 'Maria',
          user_id: '123@lid',
        },
      }),
    }
    const controller = new ContactsController(mock<Contact>(), undefined, contactBook)
    const app = express()
    app.use(express.json())
    app.post('/:phone/contacts/import', controller.save.bind(controller))

    const response = await request(app)
      .post('/5566999554300/contacts/import')
      .send({ phone_number: '5511988887777', full_name: 'Maria Silva' })
      .expect(200)

    expect(contactBook.save).toHaveBeenCalledWith('5566999554300', {
      phone_number: '5511988887777',
      full_name: 'Maria Silva',
    })
    expect(response.body).toEqual(expect.objectContaining({ success: true }))
  })
})
