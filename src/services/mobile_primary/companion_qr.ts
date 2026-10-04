const LINKED_DEVICES_PREFIX = 'https://wa.me/settings/linked_devices#'

/** Strip only the known QR envelope. Never decode or change the payload bytes. */
export function normalizeCompanionQr(value: string): string {
  return value.startsWith(LINKED_DEVICES_PREFIX) ? value.slice(LINKED_DEVICES_PREFIX.length) : value
}
