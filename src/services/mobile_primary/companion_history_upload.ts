import { dirname, join } from 'node:path'
import type { WaClientPluginContext } from 'zapo-js'
import type { HistoryUpload } from './companion_history_continuation'

/** Advanced Zapo 1.9 adapter. Public message.upload only supports ordinary media.
 * Reuse the installed SDK primitive (same proxy, cache, crypto and transfer),
 * with an explicit contract test instead of mislabeling history as a document. */
export function uploadCompanionHistory(ctx: WaClientPluginContext, bytes: Uint8Array): Promise<HistoryUpload> {
  const root = dirname(require.resolve('zapo-js'))
  const { uploadMedia } = require(join(root, 'client/messaging/messages.js'))
  const { MEDIA_UPLOAD_PATHS } = require(join(root, 'media/constants.js'))
  if (typeof uploadMedia !== 'function' || !MEDIA_UPLOAD_PATHS['md-msg-hist']) throw new Error('mobile_history_upload_unsupported')
  return uploadMedia(ctx.deps.mediaMessageBuildOptions, {
    source: bytes, cryptoType: 'history', uploadPath: MEDIA_UPLOAD_PATHS['md-msg-hist'],
    contentType: 'application/octet-stream', sidecar: false, timeoutMs: 30000,
    logLabel: 'companion history upload',
  })
}
