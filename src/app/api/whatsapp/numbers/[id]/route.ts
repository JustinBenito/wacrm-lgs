// PATCH /api/whatsapp/numbers/:id — admin-only edits that do not touch
// Meta credentials: label, owner (an account member or null), primary.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      label?: unknown
      owner_user_id?: unknown
      is_primary?: unknown
    } | null
    if (!body) return NextResponse.json({ error: t('whatsappConfig.labelInvalid') }, { status: 400 })

    const { data: row } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!row) return NextResponse.json({ error: t('whatsappConfig.numberNotFound') }, { status: 404 })

    const update: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (body.label !== null && typeof body.label !== 'string')
        return NextResponse.json({ error: t('whatsappConfig.labelInvalid') }, { status: 400 })
      update.label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) || null : null
    }
    if (body.owner_user_id !== undefined) {
      if (body.owner_user_id === null) update.owner_user_id = null
      else if (typeof body.owner_user_id === 'string') {
        const { data: member } = await ctx.supabase
          .from('profiles')
          .select('user_id')
          .eq('user_id', body.owner_user_id)
          .eq('account_id', ctx.accountId)
          .maybeSingle()
        if (!member) return NextResponse.json({ error: t('whatsappConfig.ownerInvalid') }, { status: 400 })
        update.owner_user_id = body.owner_user_id
      } else return NextResponse.json({ error: t('whatsappConfig.ownerInvalid') }, { status: 400 })
    }

    if (body.is_primary === true) {
      const { error: demote } = await ctx.supabase
        .from('whatsapp_config')
        .update({ is_primary: false })
        .eq('account_id', ctx.accountId)
        .eq('is_primary', true)
        .neq('id', id)
      if (demote) return NextResponse.json({ error: t('whatsappConfig.updateFailed') }, { status: 500 })
      update.is_primary = true
    }

    if (Object.keys(update).length === 0)
      return NextResponse.json({ error: t('whatsappConfig.labelInvalid') }, { status: 400 })

    const { error } = await ctx.supabase
      .from('whatsapp_config')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[PATCH /api/whatsapp/numbers/:id]', error)
      return NextResponse.json({ error: t('whatsappConfig.updateFailed') }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
