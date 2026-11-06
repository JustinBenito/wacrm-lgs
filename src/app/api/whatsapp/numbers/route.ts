// GET /api/whatsapp/numbers
//
// Lists the account's WhatsApp numbers WITHOUT credentials (no access or
// verify tokens ever leave the server through this route). Any member can
// list; in 'own' visibility mode an agent only sees numbers they own.

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getAgentVisibility } from '@/lib/whatsapp/numbers'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select(
        'id, label, phone_number_id, waba_id, status, is_primary, owner_user_id, registered_at, connected_at, created_at'
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[GET /api/whatsapp/numbers]', error)
      return NextResponse.json({ error: t('whatsappConfig.fetchFailed') }, { status: 500 })
    }

    const visibility = await getAgentVisibility(ctx.supabase, ctx.accountId)
    const scoped =
      !hasMinRole(ctx.role, 'admin') && visibility === 'own'
        ? (data ?? []).filter((n) => n.owner_user_id === ctx.userId)
        : (data ?? [])

    return NextResponse.json({ numbers: scoped, visibility, userId: ctx.userId, role: ctx.role })
  } catch (err) {
    return toErrorResponse(err)
  }
}
