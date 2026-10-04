import { renderContactEditor, saveContactName } from '../../frontend/features/contact_editor'
import { renderContactCards } from '../../frontend/features/entities'
import type { ApiClient } from '../../frontend/core/api'

const contact = { user_id: '123@lid', phone_number: '5511999999999', push_name: 'Perfil', display_name: 'Agenda', last_updated_ms: 1 }

describe('contact name editor', () => {
  test('renders new-contact fields and omits a fabricated LID from the request', async () => {
    expect(renderContactEditor()).toContain('Adicionar contato')
    expect(renderContactEditor()).toContain('name="phone_number"')
    const request = jest.fn().mockResolvedValue({ success: true })
    await saveContactName({ request } as unknown as ApiClient, '5511888888888', { phone_number: '+55 (11) 99999-9999' }, 'Maria')
    const payload = JSON.parse(request.mock.calls[0][1].body)
    expect(payload).toEqual({ phone_number: '5511999999999', full_name: 'Maria' })
  })

  test.each(['abc5511999999999', '', '123', '0'.repeat(16), '++5511999999999', '55+11999999999', '5511999', '5500999999999', '55119999999999'])('rejects malformed phone %s without sending', async phone_number => {
    const request = jest.fn()
    await expect(saveContactName({ request } as unknown as ApiClient, '5511888888888', { phone_number }, 'Maria')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  test.each(['+5566999999999', '5566999999999', '+55 (66) 99999-9999'])('accepts Brazilian phone with or without leading plus: %s', async phone_number => {
    const request = jest.fn().mockResolvedValue({ success: true })
    await saveContactName({ request } as unknown as ApiClient, '5511888888888', { phone_number }, 'Maria')
    expect(JSON.parse(request.mock.calls[0][1].body).phone_number).toBe('5566999999999')
  })
  test('uses shared form layout, name before phone and a non-submit cancel action', () => {
    const html = renderContactEditor()
    expect(html).toContain('class="stack" data-form="contact-name"')
    expect(html.indexOf('name="full_name"')).toBeLessThan(html.indexOf('name="phone_number"'))
    expect(html).toContain('class="field"')
    expect(html).toContain('class="form-actions"')
    expect(html).toContain('type="button" class="btn btn--ghost" data-close-modal')
  })
  test('prefers address-book name, falls back to push name and escapes input', () => {
    expect(renderContactEditor(contact)).toContain('value="Agenda"')
    expect(renderContactEditor({ ...contact, display_name: undefined })).toContain('value="Perfil"')
    expect(renderContactEditor({ ...contact, display_name: '"><script>' })).not.toContain('<script>')
    expect(renderContactCards([contact], '5511888888888')).toContain('data-action="edit-contact-name"')
    expect(renderContactCards([{ ...contact, phone_number: undefined }], '5511888888888')).not.toContain('data-action="edit-contact-name"')
  })

  test('sends the canonical identity and trimmed name through the authenticated API', async () => {
    const request = jest.fn().mockResolvedValue({ success: true })
    await saveContactName({ request } as unknown as ApiClient, '5511888888888', contact, '  Nome novo  ')
    expect(request).toHaveBeenCalledWith('/5511888888888/contacts/import', {
      method: 'POST', body: JSON.stringify({ phone_number: contact.phone_number, user_id: contact.user_id, full_name: 'Nome novo' }),
    })
  })

  test.each([' ', 'x'.repeat(257)])('rejects invalid names before sending', async name => {
    const request = jest.fn()
    await expect(saveContactName({ request } as unknown as ApiClient, '5511888888888', contact, name)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  test('does not treat unsuccessful responses or network failures as saved', async () => {
    const request = jest.fn().mockResolvedValue({ success: false })
    await expect(saveContactName({ request } as unknown as ApiClient, '5511888888888', contact, 'Nome')).rejects.toThrow()
    request.mockRejectedValue(new Error('offline'))
    await expect(saveContactName({ request } as unknown as ApiClient, '5511888888888', contact, 'Nome')).rejects.toThrow('offline')
  })
})
