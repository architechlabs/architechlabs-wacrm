import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeEmbeddedSignupCode,
  listWabaPhoneNumbers,
  requestSmbAppData,
  subscribeWabaToApp,
} from '@/lib/whatsapp/meta-api'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function admin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Finish Embedded Signup: exchange the code, subscribe the WABA,
 * store one encrypted row per phone, and request coexistence sync.
 * The business token is never returned.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    const wabaId = typeof body?.waba_id === 'string' ? body.waba_id.trim() : ''
    const sessionPhoneId = typeof body?.phone_number_id === 'string' ? body.phone_number_id.trim() : ''
    if (!code || !wabaId) {
      return NextResponse.json({ error: 'code and waba_id are required' }, { status: 400 })
    }

    const accessToken = await exchangeEmbeddedSignupCode(code)
    await subscribeWabaToApp({ wabaId, accessToken })
    let phones = await listWabaPhoneNumbers({ wabaId, accessToken })
    if (sessionPhoneId) {
      const match = phones.filter((phone) => phone.id === sessionPhoneId)
      if (match.length > 0) phones = match
    }
    if (phones.length === 0) {
      return NextResponse.json({ error: 'Meta did not return a phone number for this account' }, { status: 400 })
    }

    const encryptedToken = encrypt(accessToken)
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN
    const encryptedVerify = verifyToken ? encrypt(verifyToken) : null
    const now = new Date().toISOString()
    const saved: Array<{ phone_number_id: string; display_phone_number?: string }> = []

    const { data: defaultRow } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_default', true)
      .maybeSingle()
    let hasDefault = Boolean(defaultRow)

    for (const phone of phones) {
      const { data: claimed } = await admin()
        .from('whatsapp_config')
        .select('id, account_id')
        .eq('phone_number_id', phone.id)
        .maybeSingle()
      if (claimed && claimed.account_id !== accountId) {
        return NextResponse.json(
          { error: 'This WhatsApp phone number is already linked to another account.' },
          { status: 409 },
        )
      }

      if (phone.is_on_biz_app) {
        await requestSmbAppData({
          phoneNumberId: phone.id,
          accessToken,
          syncType: 'smb_app_state_sync',
        })
        await requestSmbAppData({
          phoneNumberId: phone.id,
          accessToken,
          syncType: 'history',
        })
      }

      const row = {
        phone_number_id: phone.id,
        waba_id: wabaId,
        display_phone_number: phone.display_phone_number ?? null,
        verified_name: phone.verified_name ?? null,
        is_on_biz_app: Boolean(phone.is_on_biz_app),
        source: 'embedded_signup',
        access_token: encryptedToken,
        verify_token: encryptedVerify,
        status: 'connected',
        connected_at: now,
        subscribed_apps_at: now,
        registered_at: phone.is_on_biz_app ? now : null,
        last_registration_error: null,
        updated_at: now,
      }

      if (claimed) {
        const { error } = await supabase
          .from('whatsapp_config')
          .update(row)
          .eq('id', claimed.id)
          .eq('account_id', accountId)
        if (error) throw new Error(error.message)
      } else {
        const isDefault = !hasDefault
        const { error } = await supabase.from('whatsapp_config').insert({
          ...row,
          account_id: accountId,
          user_id: userId,
          is_default: isDefault,
        })
        if (error) throw new Error(error.message)
        if (isDefault) hasDefault = true
      }

      saved.push({
        phone_number_id: phone.id,
        display_phone_number: phone.display_phone_number,
      })
    }

    return NextResponse.json({ success: true, numbers: saved })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    const message = error instanceof Error ? error.message : 'Embedded Signup failed'
    console.error('[whatsapp/onboarding]', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
