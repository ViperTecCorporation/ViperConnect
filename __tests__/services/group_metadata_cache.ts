import { mergeGroupMetadataForCache } from '../../src/services/groups/group_metadata_cache'

describe('mergeGroupMetadataForCache', () => {
  it('preserves the cached group subject when a partial refresh omits it', () => {
    const previous: any = {
      id: '120363385315015048@g.us',
      subject: 'Grupo Comercial',
      profilePicture: 'https://example.com/group.jpg',
      participants: [{ id: '5566996269251@s.whatsapp.net' }],
    }
    const next: any = {
      id: '120363385315015048@g.us',
      participants: [{ id: '5566996269251@s.whatsapp.net' }, { id: '5566999999999@s.whatsapp.net' }],
    }

    expect(mergeGroupMetadataForCache(previous, next)).toEqual({
      id: '120363385315015048@g.us',
      subject: 'Grupo Comercial',
      profilePicture: 'https://example.com/group.jpg',
      participants: next.participants,
    })
  })
})
