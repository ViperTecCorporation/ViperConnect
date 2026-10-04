import { bindPrivacyListModals } from '../../frontend/features/privacy_list_modal'

function harness(name = 'lastSeen', value = 'all', list = '[]') {
  const handlers: Record<string, Function> = {}, dialogHandlers: Record<string, Function> = {}, formHandlers: Record<string, Function> = {}
  const input = { value: '' }, textarea = { value: '', focus: jest.fn() }, error = { textContent: '' }
  const cancel = { addEventListener: jest.fn((_event, callback) => { dialogHandlers.cancelButton = callback }) }
  const dialog: any = { setAttribute: jest.fn(), showModal: jest.fn(), remove: jest.fn(),
    addEventListener: jest.fn((event, callback) => { dialogHandlers[event] = callback }),
    querySelector: jest.fn(selector => selector === 'textarea' ? textarea : selector === '[data-cancel]' ? cancel : selector === '[data-error]' ? error : selector === 'form' ? { addEventListener: (event: string, callback: Function) => { formHandlers[event] = callback } } : { textContent: '' }),
  }
  const select: any = { name, value, disabled: false, dataset: { initial: value, list, label: name }, focus: jest.fn(), dispatchEvent: jest.fn(), matches: () => true,
    closest: (selector: string) => selector === 'form' ? form : null }
  const form = { querySelector: (selector: string) => selector.startsWith('select') ? select : input }
  const button = { dataset: { editPrivacyList: name }, closest: () => form }
  const root: any = { addEventListener: (event: string, callback: Function) => { handlers[event] = callback }, append: jest.fn() }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: jest.fn(() => dialog) } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { alert: jest.fn() } })
  bindPrivacyListModals(root)
  return { select, input, dialog, textarea, error, root,
    click: () => handlers.click({ target: { closest: () => button }, preventDefault: jest.fn() }),
    change: () => handlers.change({ target: select }),
    cancel: () => dialogHandlers.cancelButton(),
    escape: () => dialogHandlers.cancel({ preventDefault: jest.fn() }),
    submit: () => formHandlers.submit({ preventDefault: jest.fn(), stopPropagation: jest.fn() }),
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  for (const [key, descriptor] of [['document', originalDocument], ['window', originalWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
})

test.each(['lastSeen', 'profilePicture', 'about', 'groupAdd', 'linkedProfiles', 'pix'])('button opens %s from all and cancellation restores it', name => {
  const h = harness(name)
  h.click()
  expect(h.dialog.showModal).toHaveBeenCalledTimes(1)
  expect(h.select.value).toBe('contact_blacklist')
  h.cancel()
  expect(h.select.value).toBe('all')
  expect(h.input.value).toBe('')
})

test.each(['contacts', 'none', 'contact_blacklist'])('opens current mode %s and saves only a draft', value => {
  const h = harness('lastSeen', value)
  h.click(); h.textarea.value = '5511999999999'; h.submit()
  expect(h.select.value).toBe('contact_blacklist')
  expect(JSON.parse(h.input.value).add).toEqual(['5511999999999@s.whatsapp.net'])
  expect(h.select.dispatchEvent).toHaveBeenCalledTimes(1)
  expect(h.dialog.remove).toHaveBeenCalled()
})

test.each(['', 'CONTACTS', 'ALLOW_LIST', 'DENY_LIST'])('status button opens mode %s and Escape restores it', mode => {
  const h = harness('mode', mode); h.click()
  expect(h.dialog.showModal).toHaveBeenCalled()
  expect(h.select.value).toBe(mode === 'ALLOW_LIST' ? mode : 'DENY_LIST')
  h.escape(); expect(h.select.value).toBe(mode)
})

test('selecting except still opens and rejects invalid contact drafts', () => {
  const h = harness(); h.select.value = 'contact_blacklist'; h.change()
  expect(h.dialog.showModal).toHaveBeenCalled()
  h.textarea.value = 'invalid'; h.submit()
  expect(h.error.textContent).toContain('100')
  expect(h.dialog.remove).not.toHaveBeenCalled()
})

test('unknown baseline gives feedback and never replaces it with an empty list', () => {
  const h = harness('lastSeen', 'all', 'null'); h.click()
  expect(window.alert).toHaveBeenCalled()
  expect(h.dialog.showModal).not.toHaveBeenCalled()
  expect(h.select.value).toBe('all')
})

test('disabled setting is not editable', () => {
  const h = harness(); h.select.disabled = true; h.click()
  expect(h.dialog.showModal).not.toHaveBeenCalled()
})
