export type ContactDirectoryQuery = {
  cursor?: string
  limit?: number
}

export type ContactDirectoryItem = {
  user_id: string
  phone_number?: string
  display_name?: string
  push_name?: string
  last_updated_ms: number
}

export type ContactDirectoryPage = {
  contacts: ContactDirectoryItem[]
  next_cursor: string
  has_more: boolean
}

export interface ContactDirectory {
  list(phone: string, query?: ContactDirectoryQuery): Promise<ContactDirectoryPage>
}
