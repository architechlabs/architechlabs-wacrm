import { describe, expect, it } from 'vitest'
import {
  UNSUPPORTED_MESSAGE_LABEL,
  dedupeIncomingMessages,
  echoCustomerWaId,
  embeddedSignupSteps,
  historyDirection,
  historyThreads,
  shouldRegisterPhone,
  stateSyncContacts,
} from './coexistence'

describe('coexistence helpers', () => {
  it('skips PIN registration for numbers that stay on the Business app', () => {
    expect(shouldRegisterPhone(true)).toBe(false)
    expect(shouldRegisterPhone(false)).toBe(true)
  })

  it('orders Embedded Signup and adds coexistence sync only for Business-app numbers', () => {
    expect(embeddedSignupSteps(false)).toEqual(['exchange_code', 'subscribe_waba', 'list_phones'])
    expect(embeddedSignupSteps(true)).toEqual([
      'exchange_code',
      'subscribe_waba',
      'list_phones',
      'smb_app_state_sync',
      'history',
    ])
  })

  it('drops echo and history rows whose message id was already stored', () => {
    const fresh = dedupeIncomingMessages(
      [{ id: 'wamid.1' }, { id: 'wamid.2' }, { id: 'wamid.1' }, { id: '' }],
      ['wamid.2'],
    )
    expect(fresh.map((row) => row.id)).toEqual(['wamid.1'])
  })

  it('reads the customer from an echo and the sender of a history row', () => {
    expect(echoCustomerWaId({ to: '15551212' })).toBe('15551212')
    expect(historyDirection('15551212', '+1 555 1212')).toBe('inbound')
    expect(historyDirection('15550000', '15551212')).toBe('outbound')
  })

  it('keeps contact sync rows and history threads that have ids', () => {
    expect(stateSyncContacts({
      state_sync: [{
        type: 'contact',
        action: 'add',
        contact: { full_name: 'Asha', phone_number: '1555' },
      }],
    })).toEqual([{ phone: '1555', name: 'Asha', action: 'add' }])
    expect(historyThreads({
      history: [{ threads: [{ id: '1555', messages: [{ id: 'm1', from: '1555', type: 'text' }] }] }],
    })[0].messages).toHaveLength(1)
  })

  it('uses the phone-app label for unsupported Cloud API messages', () => {
    expect(UNSUPPORTED_MESSAGE_LABEL).toBe('Unsupported message, open on phone')
  })
})
