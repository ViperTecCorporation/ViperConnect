import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

/** Cumulative microseconds / elapsed monotonic time; 100% means one core. */
export class CpuUsageDelta {
  private previous?: { usage: number; at: number; source: string }
  constructor(private readonly clock = () => performance.now()) {}
  read(usage: number, source: string): number | undefined {
    const at = this.clock(), previous = this.previous
    this.previous = Number.isFinite(usage) && usage >= 0 ? { usage, at, source } : undefined
    if (!this.previous || !previous || previous.source !== source || usage < previous.usage || at <= previous.at) return undefined
    return Math.round((usage - previous.usage) / ((at - previous.at) * 1000) * 10000) / 100
  }
}

export class ProcessCpuSampler {
  private readonly delta = new CpuUsageDelta()
  constructor(private readonly cgroup = () => readFile('/sys/fs/cgroup/cpu.stat', 'utf8')) {}
  async sample(container: boolean) {
    let usage: number | undefined, cpuSource: 'container' | 'process' = 'process'
    if (container) try {
      const match = /^usage_usec\s+(\d+)\s*$/m.exec(await this.cgroup())
      if (match && Number.isFinite(Number(match[1]))) { usage = Number(match[1]); cpuSource = 'container' }
    } catch { /* Unsupported cgroup: measure the current process instead. */ }
    if (usage === undefined) { const cpu = process.cpuUsage(); usage = cpu.user + cpu.system }
    const cpuPercent = this.delta.read(usage, cpuSource)
    return { cpuPercent, cpuMaxPercent: cpuPercent, cpuSource }
  }
}
