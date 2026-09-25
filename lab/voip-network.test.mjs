import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'

// Explicit opt-in: these tests probe the lab only, without placing a SIP call.
test('local Docker publishes SIP and STUN UDP ports', { skip: process.env.LAB_VOIP_NETWORK_TEST !== 'true' }, async () => {
  for (const port of [3478, 5060]) {
    const socket = dgram.createSocket('udp4')
    let timeout
    try {
      const response = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`UDP ${port}: sem resposta do laboratório`)), 5000)
        socket.once('error', reject)
        socket.once('message', resolve)
      })
      const transaction = randomBytes(12)
      const data = port === 3478
        ? Buffer.concat([Buffer.from('000100002112a442', 'hex'), transaction])
        : Buffer.from('OPTIONS sip:192.168.0.112 SIP/2.0\r\nVia: SIP/2.0/UDP 192.168.0.112;rport;branch=z9hG4bK-lab-smoke\r\nFrom: <sip:lab@192.168.0.112>;tag=smoke\r\nTo: <sip:lab@192.168.0.112>\r\nCall-ID: lab-smoke\r\nCSeq: 1 OPTIONS\r\nMax-Forwards: 70\r\nContent-Length: 0\r\n\r\n')
      socket.send(data, port, '192.168.0.112')
      const received = await response
      if (port === 3478) {
        assert.equal(received.readUInt16BE(0), 0x0101)
        assert.deepEqual(received.subarray(8, 20), transaction)
      } else assert.match(received.toString(), /^SIP\/2\.0 (200|401|407)/)
    } finally {
      clearTimeout(timeout)
      socket.close()
    }
  }
})
