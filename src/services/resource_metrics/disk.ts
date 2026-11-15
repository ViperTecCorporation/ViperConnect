import { opendir, lstat, statfs } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'

export interface DiskMeasurement {
  diskBytes?: number; diskPartial: boolean; diskShared: boolean; diskSampledAt: number; fsUsedBytes?: number; fsTotalBytes?: number
}

/** Fixed entry/time budget, no symlink traversal, no file contents or recursive OS-wide scan. */
export async function measureDisk(roots: string[], shared = false, budgetMs = 750, maxEntries = 10000): Promise<DiskMeasurement> {
  const started = Date.now(), unique = [...new Set(roots.filter(Boolean).map(root => resolve(root)))].sort((a, b) => a.length - b.length)
  const selected = unique.filter((root, i) => !unique.slice(0, i).some(parent => root.startsWith(parent + sep)))
  const visited = new Set<string>(), pending = [...selected]; let bytes = 0, entries = 0, partial = false, measured = false
  while (pending.length && !partial) {
    const path = pending.pop()!
    if (Date.now() - started > budgetMs || entries >= maxEntries) { partial = true; break }
    try {
      const info = await lstat(path), identity = `${info.dev}:${info.ino}`
      if (info.isSymbolicLink() || visited.has(identity)) continue
      visited.add(identity); measured = true
      if (!info.isDirectory()) { bytes += info.size; continue }
      const directory = await opendir(path)
      for await (const entry of directory) {
        if (++entries > maxEntries || Date.now() - started > budgetMs) { partial = true; break }
        if (entry.isSymbolicLink()) continue
        const child = join(path, entry.name)
        if (entry.isDirectory()) pending.push(child)
        else if (entry.isFile()) {
          const file = await lstat(child), key = `${file.dev}:${file.ino}`
          if (file.isSymbolicLink()) continue
          if (!visited.has(key)) { visited.add(key); bytes += file.size }
        }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') partial = true }
  }
  let capacity: { fsUsedBytes?: number; fsTotalBytes?: number } = {}
  if (selected[0]) try {
    const value = await statfs(selected[0])
    capacity = { fsUsedBytes: (value.blocks - value.bfree) * value.bsize, fsTotalBytes: value.blocks * value.bsize }
  } catch {}
  return { diskBytes: measured ? bytes : undefined, diskPartial: partial, diskShared: shared, diskSampledAt: Date.now(), ...capacity }
}
