import { realpath, stat } from 'fs/promises'
import path from 'path'

// Express has already decoded the route parameter. Never decode it a second time.
export async function resolvePublicFile(root: string, file: string): Promise<string | undefined> {
  if (!file || /[\x00-\x1f\\:]/.test(file) || path.posix.isAbsolute(file)) return undefined
  if (file.split('/').some(part => part === '..' || (part.startsWith('.') && part !== '.env.example'))) return undefined
  try {
    const base = await realpath(root)
    const target = await realpath(path.resolve(base, file))
    const relative = path.relative(base, target)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
    return (await stat(target)).isFile() ? target : undefined
  } catch {
    return undefined
  }
}
