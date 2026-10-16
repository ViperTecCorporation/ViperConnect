// Public Uno IDs remain operational IDs. These aliases are correlation metadata only.
export const addProviderMessageIds = (payload: any, identities: ReadonlyMap<string, string>) => {
  const attach = (target: any, id?: string) => {
    const original = id && identities.get(id)
    if (target && original) target.provider_message_id = original
  }
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {}
      for (const message of [...(value.messages || []), ...(value.message_echoes || [])]) {
        attach(message, message.id)
        attach(message.context, message.context?.id || message.context?.message_id)
        attach(message.reaction, message.reaction?.message_id)
      }
      for (const status of value.statuses || []) attach(status, status.id)
    }
  }
}

// Call only on a destination-specific copy: other consumers retain their aliases.
export const removeProviderMessageIds = (payload: any) => {
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {}
      for (const item of [...(value.messages || []), ...(value.message_echoes || []), ...(value.statuses || [])]) {
        delete item.provider_message_id
        if (item.context) delete item.context.provider_message_id
        if (item.reaction) delete item.reaction.provider_message_id
      }
    }
  }
}
