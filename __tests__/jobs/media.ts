import { MediaJob } from '../../src/jobs/media'

test('scheduled cleanup is idempotent only for multipart restore objects', async () => {
  const mediaStore = { hasMedia: jest.fn(async () => false), removeMedia: jest.fn(async () => {}) }
  const job = new MediaJob((async () => ({ getStore: async () => ({ mediaStore }) })) as any)
  const part = 'session-restore-uploads/12345678-1234-4123-8123-123456789012/0.part'
  await job.consume('session-transfer-upload', { fileName: part })
  expect(mediaStore.removeMedia).not.toHaveBeenCalled()
  mediaStore.hasMedia.mockResolvedValueOnce(true)
  await job.consume('session-transfer-upload', { fileName: part })
  expect(mediaStore.removeMedia).toHaveBeenCalledWith(part)
  mediaStore.removeMedia.mockClear(); mediaStore.hasMedia.mockClear()
  await job.consume('session', { fileName: 'normal-photo.jpg' })
  expect(mediaStore.removeMedia).toHaveBeenCalledWith('normal-photo.jpg')
  expect(mediaStore.hasMedia).not.toHaveBeenCalled()
})
