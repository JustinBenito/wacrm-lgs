import type { SupabaseClient } from '@supabase/supabase-js'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Conversation tenancy guard for the service-role send paths.
//
// Both engines persist an outbound message as `messages.insert({
// conversation_id })` plus a `conversations` preview update, through
// the service-role client — so RLS does not scope either write, and an
// INSERT has no `WHERE` clause to hang a tenancy predicate off.
//
// The engines already refuse a contact outside the account. A
// conversation id was taken on trust, which is what made
// GHSA-m4fx-g6pr-hrw8 exploitable: the manual trigger at
// POST /api/automations/engine copies `body.context` verbatim into the
// run, so `context.conversation_id` is caller-controlled, and a known
// foreign UUID wrote a message row into another tenant's thread.
//
// Callers check here before the Meta call rather than after: once Meta
// has the message it is delivered, and there is nothing left to undo.
// ------------------------------------------------------------

/**
 * Throw unless `conversationId` is a conversation of `accountId`; returns the
 * WhatsApp number the conversation lives on.
 *
 * The message is deliberately the same for "no such conversation" and
 * "not yours" — the engines surface it into automation logs the
 * triggering user can read, and distinguishing the two would confirm
 * whether a given UUID exists.
 */
export async function assertConversationInAccount(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
): Promise<{ whatsappConfigId: string | null }> {
  const { data, error } = await db
    .from('conversations')
    .select('id, whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    throw new Error(t('send.conversationLookupFailed', { message: error.message }))
  }
  if (!data) {
    throw new Error(t('send.conversationNotFound'))
  }
  // The number (migration 060) the thread lives on — callers that go on
  // to talk to Meta must send from THIS number, not "the account's".
  return {
    whatsappConfigId:
      (data as { whatsapp_config_id?: string | null }).whatsapp_config_id ??
      null,
  }
}
