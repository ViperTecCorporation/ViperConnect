import { rabbitManagementOptions } from '../rabbitmq_management'

type Counters = { runtime: number; wall: number; node: string; unit: string }

export function rabbitCpuCounters(text: string): Counters {
  const node = /(?:^|\n)rabbitmq_identity_info\{[^\n]*?rabbitmq_node="([^"\\]+)"/.exec(text)?.[1]
  const metric = (key: string) => {
    const values = [...text.matchAll(new RegExp(`^${key}(?:\\{[^\\n]*\\})?\\s+([0-9.eE+\\-]+)(?:\\s+[0-9]+)?\\s*$`, 'gm'))]
    const value = values.length === 1 ? Number(values[0][1]) : NaN
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  for (const unit of ['seconds_total', 'milliseconds']) {
    const runtime = metric(`erlang_vm_statistics_runtime_${unit}`), wall = metric(`erlang_vm_statistics_wallclock_time_${unit}`)
    if (node && runtime !== undefined && wall !== undefined) return { runtime, wall, node, unit }
  }
  throw new Error('rabbit_cpu_counters_unavailable')
}

export class RabbitCpuDelta {
  private previous?: Counters
  reset() { this.previous = undefined }
  read(value: Counters) {
    const previous = this.previous; this.previous = value
    if (!previous || previous.node !== value.node || previous.unit !== value.unit || value.runtime < previous.runtime || value.wall <= previous.wall) return undefined
    // Runtime and wall counters use the same exporter unit; their ratio is unit-free.
    return Math.round((value.runtime - previous.runtime) / (value.wall - previous.wall) * 10000) / 100
  }
}

export class RabbitCpuSampler {
  private readonly delta = new RabbitCpuDelta()
  constructor(private readonly options?: ReturnType<typeof rabbitManagementOptions>, private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = process.env.RABBITMQ_PROMETHEUS_URL || '') {}
  async sample(nodes: { name?: string; running?: boolean }[]) {
    try {
      const options = this.options || rabbitManagementOptions()
      const url = new URL(options.baseUrl); url.port = '15692'; url.pathname = '/metrics'; url.search = ''
      const response = await this.fetcher(this.endpoint || url.toString(), {
        headers: { Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`, Accept: 'text/plain' },
        redirect: 'error', signal: AbortSignal.timeout(2000),
      })
      if (!response.ok || !response.body) throw new Error('rabbit_cpu_unavailable')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          size += value.byteLength; if (size > 1048576) throw new Error('rabbit_cpu_response_too_large')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => undefined) }
      const counters = rabbitCpuCounters(Buffer.concat(chunks).toString('utf8'))
      if (!nodes.some(node => node.name === counters.node && node.running === true)) throw new Error('rabbit_cpu_node_mismatch')
      const cpuPercent = this.delta.read(counters)
      return { cpuPercent, cpuMaxPercent: cpuPercent, cpuSource: 'rabbitmq-runtime' as const, cpuPartial: nodes.length !== 1 }
    } catch { this.delta.reset(); return {} }
  }
}
