import { mockDeep } from 'jest-mock-extended'
import type Redis from 'ioredis'
import { SessionMessageIndex } from '../../src/services/messages/session_message_index'
import { cachedMessageGroups, cachedMessageSenderNames } from '../../src/services/messages/session_message_names'

const setup = () => {
  const redis = mockDeep<Redis>()
  const pipe: any = { get: jest.fn().mockReturnThis(), hgetall: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) }
  redis.pipeline.mockReturnValue(pipe)
  return { redis, pipe, index: new SessionMessageIndex(redis, 'test:') }
}
test('reads only bounded session group metadata and tolerates malformed cache', async () => {
  const { pipe, index } = setup()
  pipe.exec.mockResolvedValue([[null, '{"subject":"Team"}'], [null, 'invalid']])
  const groups = await cachedMessageGroups(index, '5511', ['1@g.us', '1@g.us', '2@g.us', '3@lid'])
  expect(groups.get('1@g.us').subject).toBe('Team')
  expect(groups.get('2@g.us')).toEqual({})
  expect(pipe.get.mock.calls).toEqual([['unoapi-group:5511:1@g.us'], ['unoapi-group:5511:2@g.us']])
})
test('canonicalizes device sender, deduplicates and prefers saved names over push names', async () => {
  const { pipe, index } = setup()
  pipe.exec.mockResolvedValue([[null, { display_name: 'Ana', push_name: 'Push' }], [null, 'Legacy'], [null, '{}'], [null, null]])
  const names = await cachedMessageSenderNames(index, '5511', ['123:17@lid', '123@lid'], {})
  expect(names.get('123:17@lid')).toBe('Ana')
  expect(names.get('123@lid')).toBe('Ana')
  expect(pipe.hgetall).toHaveBeenCalledTimes(1)
  expect(pipe.hgetall).toHaveBeenCalledWith('test:contact:5511:123@lid')
})
test('uses participant phone to resolve a cached name without global mappings or scans', async () => {
  const { pipe, redis, index } = setup()
  pipe.exec.mockResolvedValueOnce([[null, {}], [null, null], [null, 'broken'], [null, null]])
    .mockResolvedValueOnce([[null, { push_name: 'Bruno' }], [null, null], [null, '{}'], [null, null]])
  const names = await cachedMessageSenderNames(index, '5511', ['123@lid'], { participants: [{ jid: '123@lid', phoneNumber: '5511999999999@s.whatsapp.net' }] })
  expect(names.get('123@lid')).toBe('Bruno')
  expect(pipe.hgetall).toHaveBeenCalledWith('test:contact:5511:5511999999999@s.whatsapp.net')
  expect(redis.scan).not.toHaveBeenCalled()
  expect(redis.keys).not.toHaveBeenCalled()
})
test('missing cache does not fabricate a contact name and Redis failures remain explicit', async () => {
  const { pipe, index } = setup()
  expect((await cachedMessageSenderNames(index, '5511', ['123@lid'], {})).get('123@lid')).toBeUndefined()
  pipe.exec.mockResolvedValue([[new Error('offline'), null]])
  await expect(cachedMessageGroups(index, '5511', ['1@g.us'])).rejects.toThrow('session_messages_read_failed')
  await expect(cachedMessageSenderNames(index, '5511', ['123@lid'], {})).rejects.toThrow('session_messages_read_failed')
})
