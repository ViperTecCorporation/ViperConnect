import { requestRestoredConnection } from '../../src/services/mobile_primary/restored_connection'

test('restore requests worker connection without claiming it is already online', async () => {
  const dispatch = jest.fn().mockResolvedValue(undefined)
  expect(await requestRestoredConnection('999123456789', dispatch)).toEqual({ autoConnect: true, status: 'connection_requested' })
  expect(dispatch).toHaveBeenCalledWith('999123456789')
})

test('dispatch failure preserves restore success and returns a sanitized warning', async () => {
  const dispatch = jest.fn().mockRejectedValue(new Error('secret broker credentials'))
  expect(await requestRestoredConnection('999123456789', dispatch)).toEqual({ autoConnect: true, status: 'disconnected', warning: 'restore_connection_dispatch_failed' })
  expect(dispatch).toHaveBeenCalledTimes(1)
})
