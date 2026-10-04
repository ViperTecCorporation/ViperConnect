import { accountEmailError, accountEmailFeedback } from '../../frontend/features/profile_email_feedback'
import { renderAccountEmail } from '../../frontend/features/profile_email'

test('every email action has an accessible inline feedback slot', () => {
  expect(renderAccountEmail().match(/data-email-feedback/g)).toHaveLength(5)
})
test('formats provider errors without echoing private unknown messages', () => {
  const error = Object.assign(new Error('profile_email_provider_request_failed'), { status: 502 })
  expect(accountEmailError(error)).toContain('HTTP 502')
  expect(accountEmailError(error)).toContain('não está confirmado')
  expect(accountEmailError(new Error('private@example.com 123456'))).not.toMatch(/private|123456/)
  expect(accountEmailError(new Error('profile_email_code_incorrect'))).toContain('Código incorreto')
})
test('progress and final result restore button without replacing draft inputs', () => {
  const button: any = { textContent: 'Solicitar código', dataset: {}, setAttribute: jest.fn() }
  const feedback: any = { hidden: true, setAttribute: jest.fn() }
  const form = { querySelector: (s: string) => s === '[data-email-feedback]' ? feedback : button }
  const root: any = { querySelector: () => form }
  accountEmailFeedback(root, 'email-request_code', 'pending')
  expect(button.textContent).toBe('Solicitando código…'); expect(button.disabled).toBe(true)
  expect(feedback.hidden).toBe(false)
  accountEmailFeedback(root, 'email-request_code', 'error', 'Falha HTTP 502')
  expect(button.disabled).toBe(false); expect(button.textContent).toBe('Solicitar código')
  expect(feedback.textContent).toBe('Falha HTTP 502')
  expect(feedback.setAttribute).toHaveBeenLastCalledWith('role', 'alert')
  accountEmailFeedback(root, 'email-request_code', 'success', 'Solicitado')
  expect(feedback.textContent).toBe('Solicitado'); expect(feedback.className).toBe('field-help')
  expect(() => accountEmailFeedback(undefined, 'email-get', 'pending')).not.toThrow()
})
