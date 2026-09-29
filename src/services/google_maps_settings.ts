import { BASE_KEY, getRedis } from './redis'

/** Browser-restricted key; never return it from the administrative status API. */
export class GoogleMapsSettings {
  constructor(private readonly redis = getRedis) {}
  private key = `${BASE_KEY}settings:google-maps:browser-key`
  async status() { return { configured: !!await (await this.redis()).get(this.key) } }
  async browserConfig() { return { apiKey: await (await this.redis()).get(this.key) || null } }
  async save(apiKey: string) { await (await this.redis()).set(this.key, apiKey) }
  async remove() { await (await this.redis()).del(this.key) }
}
