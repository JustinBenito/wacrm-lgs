import type { SupabaseClient } from '@supabase/supabase-js'

import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

// ------------------------------------------------------------
// WhatsApp numbers (multi-number accounts, migration 060)
//
// An account used to own exactly one `whatsapp_config` row. It now owns
// one row per WhatsApp number: every sales rep can run their own number
// while the contacts, deals and notes stay in one shared CRM.
//
// Every code path that has to talk to Meta needs to answer ONE
// question: "which number do I send this from?". This module is the
// single place that answers it, so the rule is identical for the inbox
// composer, the public API, automations, flows, the AI auto-reply and
// broadcasts.
//
// Resolution order (first match wins):
//   1. an explicit number id the caller asked for (must be in the account)
//   2. the number the conversation lives on
//   3. a connected number the acting member owns
//   4. the account's primary number
//   5. any connected number (oldest first)
//   6. any number at all (oldest first)
//
// Steps 1-2 are STRICT: if the caller named a number, or the thread
// already lives on one, we never silently send from a different one —
// a customer who wrote to Priya's number must not get a reply from
// Arun's. Steps 3-6 only run when nothing was pinned.
// ------------------------------------------------------------

/** The columns the resolver and its callers rely on. `*` rows satisfy it. */
export interface WhatsAppNumberRow {
  id: string
  account_id: string
  user_id: string
  owner_user_id: string | null
  label: string | null
  is_primary: boolean
  status: string
  phone_number_id: string
  access_token: string
  created_at?: string | null
  // Extra columns (waba_id, verify_token, mirror_inbound_media, ...) ride along.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface PickNumberOptions {
  /** Explicit number the caller asked for. */
  configId?: string | null
  /** The `conversations.whatsapp_config_id` of the thread being served. */
  conversationConfigId?: string | null
  /** The acting member (the agent sending from the inbox). */
  userId?: string | null
}

const byCreatedAt = (a: WhatsAppNumberRow, b: WhatsAppNumberRow): number => {
  const ta = a.created_at ? Date.parse(a.created_at) : 0
  const tb = b.created_at ? Date.parse(b.created_at) : 0
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Pure selection over an account's numbers — no I/O, so the rule above
 * is unit-testable on its own. Returns null when nothing qualifies
 * (empty list, or a pinned number that is not in the list).
 */
export function pickWhatsAppNumber<T extends WhatsAppNumberRow>(
  rows: readonly T[],
  opts: PickNumberOptions = {}
): T | null {
  if (rows.length === 0) return null

  // 1 + 2: pinned — strict, no fallback.
  const pinned = opts.configId ?? null
  if (pinned) return rows.find((r) => r.id === pinned) ?? null
  const threadNumber = opts.conversationConfigId ?? null
  if (threadNumber) return rows.find((r) => r.id === threadNumber) ?? null

  const sorted = [...rows].sort(byCreatedAt)
  const connected = sorted.filter((r) => r.status === 'connected')

  // 3: the acting member's own connected number.
  if (opts.userId) {
    const own = connected.find((r) => r.owner_user_id === opts.userId)
    if (own) return own
  }

  // 4: the account's primary.
  const primary = sorted.find((r) => r.is_primary)
  if (primary && (primary.status === 'connected' || connected.length === 0)) {
    return primary
  }

  // 5 + 6.
  return connected[0] ?? sorted[0] ?? null
}

export interface ResolveNumberArgs extends PickNumberOptions {
  accountId: string
  /** Column list for the select. Defaults to `*`. */
  select?: string
}

/**
 * Load the account's numbers and pick one per {@link pickWhatsAppNumber}.
 * When `conversationConfigId` is not given but a `conversationId` is,
 * the thread's own number is looked up first.
 */
export async function resolveWhatsAppNumber<
  T extends WhatsAppNumberRow = WhatsAppNumberRow,
>(
  db: SupabaseClient,
  args: ResolveNumberArgs & { conversationId?: string | null }
): Promise<T | null> {
  let conversationConfigId = args.conversationConfigId ?? null
  if (!args.configId && !conversationConfigId && args.conversationId) {
    const { data } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .maybeSingle()
    conversationConfigId =
      (data as { whatsapp_config_id?: string | null } | null)
        ?.whatsapp_config_id ?? null
  }

  // The picker needs these columns whatever the caller selected.
  const required =
    'id, account_id, user_id, owner_user_id, label, is_primary, status, phone_number_id, access_token, created_at'
  const select =
    !args.select || args.select === '*' ? '*' : `${required}, ${args.select}`

  const { data, error } = await db
    .from('whatsapp_config')
    .select(select)
    .eq('account_id', args.accountId)
    .order('created_at', { ascending: true })

  if (error || !data) return null

  return pickWhatsAppNumber(data as unknown as T[], {
    configId: args.configId,
    conversationConfigId,
    userId: args.userId,
  })
}

/**
 * Which number a NEW conversation with this contact should open on,
 * for a member who initiates it (Contact → Send template, public API).
 * Prefers the member's own number, then the account primary.
 */
export async function resolveNumberForNewConversation<
  T extends WhatsAppNumberRow = WhatsAppNumberRow,
>(
  db: SupabaseClient,
  args: { accountId: string; userId?: string | null; configId?: string | null }
): Promise<T | null> {
  return resolveWhatsAppNumber<T>(db, args)
}

/** Human label for a number: its label, falling back to the Meta id. */
export function numberDisplayName(row: {
  label?: string | null
  phone_number_id?: string | null
}): string {
  return (row.label && row.label.trim()) || row.phone_number_id || 'WhatsApp'
}

// ------------------------------------------------------------
// Who may use which number
// ------------------------------------------------------------

export type AgentVisibility = 'all' | 'own'

export interface NumberActor {
  userId: string
  role: AccountRole
  visibility: AgentVisibility
}

/**
 * May `actor` send from `number`?
 *
 *   owner / admin → any number of the account
 *   agent         → any number when the account shares its inbox
 *                   ('all'), only numbers they own when it does not
 *                   ('own')
 *   viewer        → never (read-only)
 *
 * The DB's RLS already hides other members' threads in 'own' mode;
 * this is the matching guard for the paths that do NOT go through a
 * conversation row (broadcasts, "send template" from a contact).
 */
export function canUseNumber(
  actor: NumberActor,
  number: { owner_user_id: string | null }
): boolean {
  if (hasMinRole(actor.role, 'admin')) return true
  if (!hasMinRole(actor.role, 'agent')) return false
  if (actor.visibility === 'all') return true
  return number.owner_user_id === actor.userId
}

/** The account's agent-visibility mode ('all' when unreadable). */
export async function getAgentVisibility(
  db: SupabaseClient,
  accountId: string
): Promise<AgentVisibility> {
  const { data } = await db
    .from('accounts')
    .select('agent_visibility')
    .eq('id', accountId)
    .maybeSingle()
  return (data as { agent_visibility?: string } | null)?.agent_visibility ===
    'own'
    ? 'own'
    : 'all'
}
