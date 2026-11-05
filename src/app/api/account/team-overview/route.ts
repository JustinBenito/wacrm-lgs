// GET /api/account/team-overview?days=30 — admin/owner dashboard data from
// the team_overview() RPC (migration 060).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const raw = Number(new URL(request.url).searchParams.get('days') ?? 30)
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 365) : 30
    const { data, error } = await ctx.supabase.rpc('team_overview', { p_days: days })
    if (error) {
      console.error('[GET /api/account/team-overview]', error)
      return NextResponse.json({ error: t('whatsappConfig.fetchFailed') }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}
