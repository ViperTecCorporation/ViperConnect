import { storageTaskError } from '../../frontend/features/session_storage'

test('call refusal explains preservation without presenting migration as successful', () => {
  const text = storageTaskError('session_storage_active_calls', 'fallback')
  expect(text).toContain('ligação foi preservada')
  expect(text).toContain('migração não começou')
  expect(storageTaskError('session_storage_voip_gate_required', 'fallback')).toContain('Atualize o worker')
})

test('other task errors remain explicit and missing errors retain the recovery instructions', () => {
  expect(storageTaskError('session_storage_source_cleanup_diverged', 'fallback')).toBe('session_storage_source_cleanup_diverged')
  expect(storageTaskError(undefined, 'fallback')).toBe('fallback')
})
