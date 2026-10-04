import { CompanionHistoryAckGate } from '../../src/services/mobile_primary/companion_history_ack_gate'

test('waits for exact-device hist_sync, not server ACK, peer_msg or another packet', async () => {
  const gate = new CompanionHistoryAckGate(), done = jest.fn()
  const result = gate.send('a', '123:2@lid', async () => undefined).then(done)
  for (const node of [
    { tag: 'ack', attrs: { id: 'a', from: '123:2@lid', type: 'hist_sync' } },
    { tag: 'receipt', attrs: { id: 'a', from: '123:2@lid', type: 'peer_msg' } },
    { tag: 'receipt', attrs: { id: 'b', from: '123:2@lid', type: 'hist_sync' } },
    { tag: 'receipt', attrs: { id: 'a', from: '123:3@lid', type: 'hist_sync' } },
  ]) gate.observe(node)
  await Promise.resolve(); await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  gate.observe({ tag: 'receipt', attrs: { id: 'a', from: '123:2@lid', type: 'hist_sync' } })
  await result
  expect(done).toHaveBeenCalledTimes(1)
})

test('captures early batched receipt during publish and permits the next packet', async () => {
  const gate = new CompanionHistoryAckGate()
  const publish = jest.fn(async () => gate.observe({ tag: 'receipt', attrs: { from: 'server', participant: '123:2@lid', type: 'hist_sync' }, content: [
    { tag: 'list', attrs: {}, content: [{ tag: 'item', attrs: { id: 'a' } }] },
  ] }))
  await gate.send('a', '123:2@lid', publish)
  await gate.send('a', '123:2@lid', publish)
  expect(publish).toHaveBeenCalledTimes(2)
})

test('timeout stops a sequential sender without sending subsequent packets', async () => {
  const gate = new CompanionHistoryAckGate(), publish = jest.fn(async () => undefined)
  const sequence = async () => { await gate.send('a', 'target', publish, 5); await gate.send('b', 'target', publish, 5) }
  await expect(sequence()).rejects.toThrow('mobile_history_hist_sync_timeout')
  expect(publish).toHaveBeenCalledTimes(1)
})

test('rejects concurrent sends and cancels on socket disposal', async () => {
  const gate = new CompanionHistoryAckGate()
  const first = gate.send('a', 'target', async () => undefined)
  await expect(gate.send('b', 'target', async () => undefined)).rejects.toThrow('already_pending')
  gate.dispose()
  await expect(first).rejects.toThrow('socket_disposed')
})

test('publish failure cleans up pending state without retrying', async () => {
  const gate = new CompanionHistoryAckGate(), publish = jest.fn(async () => { throw new Error('publish failed') })
  await expect(gate.send('a', 'target', publish)).rejects.toThrow('publish failed')
  await expect(gate.send('b', 'target', publish)).rejects.toThrow('publish failed')
  expect(publish).toHaveBeenCalledTimes(2)
})
