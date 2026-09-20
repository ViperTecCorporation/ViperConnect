export interface ManagerIdentity {
  id: string
  name: string
  username: string
  role: 'admin' | 'user'
}

export interface ManagerUser {
  id: string
  username: string
  name: string
  active: boolean
  phones: string[]
}

export interface ManagerAssignments {
  assignments: Record<string, string>
  history: { phone: string; from: string | null; to: string | null; at: string; actor: string }[]
}

export interface ManagerKey {
  id: string
  name: string
  prefix: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked: boolean
}
