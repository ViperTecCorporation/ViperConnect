import { proto } from 'zapo-js'
import { deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

type Packet = { message: proto.Message.IProtocolMessage; count: number }
/** Freeze the selected compressed pages before sending: filtered/empty pages
 * cannot inflate the denominator, and a second Redis scan cannot change it. */
export async function* progressiveHistory(pages: AsyncIterable<Packet>, maxBytes = 32 * 1024 * 1024): AsyncGenerator<Packet> {
  const selected: Packet[] = []
  let size = 0
  for await (const packet of pages) {
    const payload = packet.message.historySyncNotification?.initialHistBootstrapInlinePayload
    if (!payload) throw new Error('mobile_history_payload_missing')
    size += payload.length
    if (size > maxBytes || selected.length >= 100000) throw new Error('mobile_history_progress_capacity')
    selected.push(packet)
  }
  for (let index = 0; index < selected.length; index++) {
    const packet = selected[index], n = packet.message.historySyncNotification!
    const progress = Math.floor((index + 1) * 100 / selected.length)
    const history = proto.HistorySync.decode(await promisify(inflate)(n.initialHistBootstrapInlinePayload!))
    history.chunkOrder = index; history.progress = progress
    yield { count: packet.count, message: { ...packet.message, historySyncNotification: {
      ...n, chunkOrder: index, progress,
      initialHistBootstrapInlinePayload: await promisify(deflate)(proto.HistorySync.encode(history).finish(), { level: 1 }),
    } } }
  }
}
