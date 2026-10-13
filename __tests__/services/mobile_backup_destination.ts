import { mobileBackupDestinationHasKeys } from '../../src/services/mobile_primary/backup_destination'

test('destination conflict stops at first key even with more than 50000 records', async () => {
  const scan = jest.fn(async () => ['91', ['unoapi:zapo:msg:5566999554300:message']] as [string, string[]])
  expect(await mobileBackupDestinationHasKeys({ scan }, 'unoapi:zapo:', '5566999554300', async () => {})).toBe(true)
  expect(scan).toHaveBeenCalledTimes(1)
})
test('ignores partial phone matches and unrelated namespaces; detects UNO history', async () => {
  const scan = jest.fn()
    .mockResolvedValueOnce(['0', ['unoapi:zapo:msg:55669995543001:x', 'other:msg:5566999554300:x']])
    .mockResolvedValueOnce(['0', ['unoapi-message:5566999554300:x']])
  expect(await mobileBackupDestinationHasKeys({ scan }, 'unoapi:zapo:', '5566999554300', async () => {})).toBe(true)
})
test('empty destination is accepted and checks renew ownership', async () => {
  const scan = jest.fn(async () => ['0', []] as [string, string[]]), renew = jest.fn(async () => {})
  expect(await mobileBackupDestinationHasKeys({ scan }, 'unoapi:zapo:', '5566999554300', renew)).toBe(false)
  expect(scan).toHaveBeenCalledTimes(2)
  expect(renew).toHaveBeenCalledTimes(2)
})
