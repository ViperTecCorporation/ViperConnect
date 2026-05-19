jest.mock('node-fetch', () => jest.fn())

import fetch from 'node-fetch'
import { drainVoipCommands, mapBaileysCallStatusToVoipEvent } from '../../src/services/client_voip'
import { defaultConfig } from '../../src/services/config'

const fetchMock = fetch as unknown as jest.Mock

describe('service client voip', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  test('maps offer call status as incoming call', () => {
    expect(mapBaileysCallStatusToVoipEvent('offer')).toBe('incoming_call')
  })

  test('drains async commands from voip service', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        commands: [
          {
            action: 'send_call_node',
            session: '5566999554300',
            callId: 'call-1',
            peerJid: '559999999999@s.whatsapp.net',
            payloadBase64: 'PGNhbGwvPg==',
          },
        ],
      }),
    })

    const response = await drainVoipCommands({
      ...defaultConfig,
      voipServiceUrl: 'http://voip.local/',
      voipServiceToken: 'secret',
      voipServiceTimeoutMs: 1234,
    }, '5566999554300', 'call-1')

    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://voip.local/v1/calls/sessions/5566999554300/calls/call-1/commands/drain',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    )
  })
})
