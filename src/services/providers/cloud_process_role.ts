export const CLOUD_PROCESS_ROLES = ['all', 'web', 'broker', 'worker'] as const
export type CloudProcessRole = (typeof CLOUD_PROCESS_ROLES)[number]

export const resolveCloudProcessRole = (value: unknown): CloudProcessRole => {
  const role = `${value || 'all'}`.trim().toLowerCase()
  if (CLOUD_PROCESS_ROLES.includes(role as CloudProcessRole)) return role as CloudProcessRole
  throw new Error(`Invalid UNOAPI_PROCESS_ROLE: ${role}`)
}
