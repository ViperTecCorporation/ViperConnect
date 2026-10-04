import { companionLabOptions } from '../../src/services/mobile_primary/companion_lab_options'

test.each([
  [{}, {}],
  [{ UNOAPI_MOBILE_COMPANION_PEM_LAB: 'true' }, {}],
  [{ UNOAPI_MOBILE_PRIMARY_LAB: 'true' }, {}],
  [{ UNOAPI_MOBILE_PRIMARY_LAB: 'false', UNOAPI_MOBILE_COMPANION_PEM_LAB: 'true' }, {}],
  [{ UNOAPI_MOBILE_PRIMARY_LAB: 'true', UNOAPI_MOBILE_COMPANION_PEM_LAB: 'false' }, {}],
  [{ UNOAPI_MOBILE_PRIMARY_LAB: 'true', UNOAPI_MOBILE_COMPANION_PEM_LAB: 'true' }, { includePem: true }],
])('PEM is opt-in and requires the lab guard: %j', (env, expected) => {
  expect(companionLabOptions(env)).toEqual(expected)
})
