/** Shown in the inbox when Meta delivers a type the Cloud API cannot render. */
export const UNSUPPORTED_MESSAGE_LABEL = 'Unsupported message, open on phone'

export function shouldRegisterPhone(isOnBizApp: boolean): boolean {
  return !isOnBizApp
}

/** Order of the Embedded Signup server steps. Coexistence skips PIN registration. */
export function embeddedSignupSteps(isOnBizApp: boolean): readonly string[] {
  const steps = ['exchange_code', 'subscribe_waba', 'list_phones']
  if (isOnBizApp) return [...steps, 'smb_app_state_sync', 'history']
  return steps
}

export function dedupeIncomingMessages<T extends { id?: string | null }>(
  messages: T[],
  existingIds: Iterable<string>,
): T[] {
  const seen = new Set(existingIds)
  const fresh: T[] = []
  for (const message of messages) {
    const id = message.id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    fresh.push(message)
  }
  return fresh
}

export function echoCustomerWaId(echo: { to?: string | null }): string | null {
  const to = echo.to?.trim()
  return to || null
}

/** History rows whose `from` is the thread id were sent by the customer. */
export function historyDirection(
  from: string | undefined,
  threadId: string,
): 'inbound' | 'outbound' {
  const sender = (from ?? '').replace(/\D/g, '')
  const thread = threadId.replace(/\D/g, '')
  if (sender && thread && sender === thread) return 'inbound'
  return 'outbound'
}

export interface StateSyncContact {
  phone: string
  name: string
  action: string
}

export function stateSyncContacts(value: {
  state_sync?: Array<{
    type?: string
    action?: string
    contact?: { full_name?: string; first_name?: string; phone_number?: string }
  }>
}): StateSyncContact[] {
  const rows = value.state_sync ?? []
  const contacts: StateSyncContact[] = []
  for (const row of rows) {
    if (row.type && row.type !== 'contact') continue
    const phone = row.contact?.phone_number?.trim()
    if (!phone) continue
    const name = row.contact?.full_name?.trim() || row.contact?.first_name?.trim() || phone
    contacts.push({ phone, name, action: row.action ?? 'add' })
  }
  return contacts
}

export interface HistoryThreadMessage {
  id: string
  from?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
}

export interface HistoryThread {
  id: string
  messages: HistoryThreadMessage[]
}

export function historyThreads(value: {
  history?: Array<{ threads?: Array<{ id?: string; messages?: HistoryThreadMessage[] }> }>
}): HistoryThread[] {
  const threads: HistoryThread[] = []
  for (const chunk of value.history ?? []) {
    for (const thread of chunk.threads ?? []) {
      if (!thread.id) continue
      threads.push({
        id: thread.id,
        messages: (thread.messages ?? []).filter((message) => Boolean(message.id)),
      })
    }
  }
  return threads
}
