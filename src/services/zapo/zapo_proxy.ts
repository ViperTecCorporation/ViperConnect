import { SocksProxyAgent } from 'socks-proxy-agent'
import type { WaClientProxyOptions } from 'zapo-js'
import {
  createZapoFamilyAgent,
  resolveZapoIpFamilyPolicies,
  type ZapoFamilyAgentFactory,
  type ZapoIpFamilyEnvironment,
} from './zapo_ip_family'

type ProxyAgentFactory = (url: string) => WaClientProxyOptions['ws']

const createSocksProxyAgent: ProxyAgentFactory = (url) => new SocksProxyAgent(url)

export const createZapoProxyOptions = (
  proxyUrl?: string,
  createAgent: ProxyAgentFactory = createSocksProxyAgent,
  ipFamilyEnvironment: ZapoIpFamilyEnvironment = {},
  createFamilyAgent: ZapoFamilyAgentFactory = createZapoFamilyAgent,
  transport: 'websocket' | 'mobile-tcp' = 'websocket',
): WaClientProxyOptions | undefined => {
  const policies = resolveZapoIpFamilyPolicies(ipFamilyEnvironment)
  const url = `${proxyUrl || ''}`.trim()
  if (url) {
    const agent = createAgent(url)
    return {
      ws: agent,
      mediaUpload: agent,
      mediaDownload: agent,
      linkPreview: agent,
    }
  }

  const agents = new Map<string, WaClientProxyOptions['ws']>()
  const agentFor = (policy: (typeof policies)[keyof typeof policies]) => {
    if (policy === 'auto') return undefined
    const cached = agents.get(policy)
    if (cached) return cached
    const created = createFamilyAgent(policy)
    agents.set(policy, created)
    return created
  }

  const result: WaClientProxyOptions = {
    // Mobile TCP treats any ws agent as a real CONNECT proxy, not a DNS agent.
    // Keep its native direct transport; explicit proxies above are never bypassed.
    ws: transport === 'mobile-tcp' ? undefined : agentFor(policies.ws),
    mediaUpload: agentFor(policies.mediaUpload),
    mediaDownload: agentFor(policies.mediaDownload),
    linkPreview: agentFor(policies.linkPreview),
  }

  return Object.values(result).some(Boolean) ? result : undefined
}
