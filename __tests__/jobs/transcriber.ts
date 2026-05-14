jest.mock('audio2textjs', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    runWhisper: jest.fn(async () => ({ output: '' })),
  })),
}))

import { extractTranscriptionDestiny } from '../../src/jobs/transcriber'

describe('TranscriberJob helpers', () => {
  it('uses group or lid identifiers when the audio payload has no wa_id/from phone', () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '5566996269251' },
            contacts: [{
              profile: { name: 'Carlos Uebel' },
              group_id: '120363385315015048@g.us',
              wa_id: '',
              user_id: '248923637706980@lid',
            }],
            messages: [{
              from: '',
              from_user_id: '248923637706980@lid',
              group_id: '120363385315015048@g.us',
              type: 'audio',
            }],
          },
        }],
      }],
    }

    const destiny = extractTranscriptionDestiny(
      payload,
      payload.entry[0].changes[0].value.messages[0],
    )

    expect(destiny).toBe('120363385315015048@g.us')
  })
})
