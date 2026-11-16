import { commanderConfigPatch } from '../../src/services/commander_config_policy'

test.each(['sessionStorage', 'sessionStorageUnlinked', 'sessionStorageProvisionPending', 'sessionStorageTaskId', 'server', 'provider', 'owner',
  'mobilePrimaryDraftId', 'mobilePrimaryImported', 'mobilePrimaryDeleting', 'sessionTransferDeleting', 'baseStore', 'getStore', 'storage',
  'useRedis', 'useS3', 'connectionType', 'zapoWebClientProfile', 'getMessageMetadata', '__proto__', 'constructor'])('template configuration refuses protected %s even when falsy', key => {
  for (const value of [{ backend: 'redis', owner: 'other' }, false, null]) {
    expect(() => commanderConfigPatch({ label: 'safe', [key]: value })).toThrow('commander_config_protected_fields')
  }
})
test.each([null, undefined, false, 'scalar', ['label']])('requires a configuration object: %j', value => {
  expect(() => commanderConfigPatch(value)).toThrow('commander_config_invalid')
})
test('legitimate public patches retain previous truthy-value semantics and do not mutate their input', () => {
  const value = { label: 'Lab', ignoreGroupMessages: true, readOnReply: false, historyMaxAgeDays: 10, webhooks: [{ id: 'application', url: 'https://example.invalid/webhook', token: 'synthetic-only' }] }
  expect(commanderConfigPatch(value)).toEqual({ label: value.label, ignoreGroupMessages: true, historyMaxAgeDays: 10, webhooks: value.webhooks })
  expect(value.readOnReply).toBe(false)
})
