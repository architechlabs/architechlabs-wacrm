import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { subscribeWabaToApp, verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { disconnectWhatsAppNumber } from '@/lib/whatsapp/numbers'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await context.params
    const body = await request.json().catch(() => ({}))
    const action = body?.action
    const { data: row, error } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !row) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }

    if (action === 'default') {
      const { error: clearError } = await supabase
        .from('whatsapp_config')
        .update({ is_default: false })
        .eq('account_id', accountId)
        .eq('is_default', true)
      if (clearError) {
        return NextResponse.json({ error: 'Could not update the default number' }, { status: 500 })
      }
      const { error: setError } = await supabase
        .from('whatsapp_config')
        .update({ is_default: true })
        .eq('id', id)
        .eq('account_id', accountId)
      if (setError) {
        return NextResponse.json({ error: 'Could not update the default number' }, { status: 500 })
      }
      return NextResponse.json({ success: true })
    }

    let accessToken: string
    try {
      accessToken = decrypt(row.access_token)
    } catch {
      return NextResponse.json({ error: 'Stored token cannot be decrypted' }, { status: 400 })
    }

    if (action === 'refresh') {
      const info = await verifyPhoneNumber({
        phoneNumberId: row.phone_number_id,
        accessToken,
      })
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({
          display_phone_number: info.display_phone_number ?? null,
          verified_name: info.verified_name ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('account_id', accountId)
      if (updateError) {
        return NextResponse.json({ error: 'Could not save the refreshed number' }, { status: 500 })
      }
      return NextResponse.json({ success: true, phone_info: info })
    }

    if (action === 'subscribe') {
      if (!row.waba_id) {
        return NextResponse.json({ error: 'This number has no WABA id' }, { status: 400 })
      }
      await subscribeWabaToApp({ wabaId: row.waba_id, accessToken })
      const now = new Date().toISOString()
      await supabase
        .from('whatsapp_config')
        .update({ subscribed_apps_at: now, updated_at: now })
        .eq('id', id)
        .eq('account_id', accountId)
      return NextResponse.json({ success: true, subscribed_apps_at: now })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    const message = error instanceof Error ? error.message : 'Request failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await context.params
    const result = await disconnectWhatsAppNumber(supabase, accountId, id)
    if (!result) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    return NextResponse.json({ error: 'Could not disconnect the number' }, { status: 500 })
  }
}
