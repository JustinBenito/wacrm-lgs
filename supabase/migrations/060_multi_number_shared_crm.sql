-- ============================================================
-- 060_multi_number_shared_crm.sql
--
-- Several WhatsApp numbers, one shared CRM.
--
-- Until now an account owned exactly one WhatsApp number
-- (`whatsapp_config.UNIQUE(account_id)`) and one conversation per
-- (account, contact). That works for a shared inbox where every agent
-- answers from the same number. It does not work for a sales team where
-- every rep has their OWN WhatsApp Business number, talks to their own
-- leads from it, and an admin wants one CRM that shows everything.
--
-- What this migration does
--   1. `whatsapp_config` may now hold many rows per account. Each row
--      is a "number": it gets a label, an owning member
--      (`owner_user_id` — the rep who works that number) and an
--      `is_primary` flag (the account's default number, used by
--      automations/broadcasts/templates that have no better signal).
--   2. `conversations.whatsapp_config_id` records which number a thread
--      lives on. Uniqueness moves from (account, contact) to
--      (account, contact, number): the SAME customer chatting with two
--      reps is ONE shared contact with TWO private threads.
--   3. `accounts.agent_visibility` — 'all' (default, the historical
--      shared-inbox behaviour) or 'own' (agents only see threads on
--      their own numbers or assigned to them; owner/admin/viewer see
--      everything). Enforced in RLS, so it holds for the dashboard,
--      Realtime subscriptions and the API alike.
--   4. Lead fields on `contacts` (`lead_status`, `lead_owner_id`,
--      `source_config_id`) so the shared CRM carries the state of each
--      lead no matter which rep's number it came through.
--   5. `team_overview(days)` — one admin-only RPC that powers the
--      monitoring screen (per-number, per-member, per-lead-status).
--
-- Backwards compatible: every existing account keeps working
-- unchanged. Its single number becomes the primary number, owned by
-- the member who connected it, and every existing conversation is
-- stamped with that number. Visibility defaults to 'all'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ACCOUNT VISIBILITY MODE
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS agent_visibility TEXT NOT NULL DEFAULT 'all';

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_agent_visibility_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_agent_visibility_check
  CHECK (agent_visibility IN ('all', 'own'));

-- ============================================================
-- 2. WHATSAPP NUMBERS (whatsapp_config becomes one row per number)
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- The member who originally connected a number is its owner.
UPDATE whatsapp_config
SET owner_user_id = user_id
WHERE owner_user_id IS NULL;

-- Exactly one primary per account. Accounts with no primary yet get
-- their oldest number promoted.
UPDATE whatsapp_config w
SET is_primary = TRUE
WHERE w.id = (
        SELECT x.id FROM whatsapp_config x
        WHERE x.account_id = w.account_id
        ORDER BY x.created_at, x.id
        LIMIT 1
      )
  AND NOT EXISTS (
        SELECT 1 FROM whatsapp_config y
        WHERE y.account_id = w.account_id AND y.is_primary
      );

-- Was UNIQUE(account_id) ("one number per account", migration 017).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary
  ON whatsapp_config (account_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_owner
  ON whatsapp_config (account_id, owner_user_id);

-- A number's owner must be a member of the same account. A mismatch is
-- a caller bug, so reject it loudly rather than silently re-pointing.
CREATE OR REPLACE FUNCTION public.enforce_whatsapp_config_owner_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = NEW.owner_user_id
      AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'The number owner must be a member of this account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_whatsapp_config_owner_membership() OWNER TO postgres;

DROP TRIGGER IF EXISTS whatsapp_config_owner_membership ON whatsapp_config;
CREATE TRIGGER whatsapp_config_owner_membership
  BEFORE INSERT OR UPDATE OF owner_user_id, account_id ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.enforce_whatsapp_config_owner_membership();

-- When a member leaves an account (removed, or moved by redeeming an
-- invite), the numbers and leads they owned become unowned rather than
-- dangling. An admin re-assigns them from the Numbers screen.
CREATE OR REPLACE FUNCTION public.release_member_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.account_id IS NOT NULL
     AND NEW.account_id IS DISTINCT FROM OLD.account_id
  THEN
    UPDATE whatsapp_config
    SET owner_user_id = NULL
    WHERE account_id = OLD.account_id
      AND owner_user_id = OLD.user_id;

    UPDATE contacts
    SET lead_owner_id = NULL
    WHERE account_id = OLD.account_id
      AND lead_owner_id = OLD.user_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.release_member_ownership() OWNER TO postgres;

DROP TRIGGER IF EXISTS profiles_release_member_ownership ON profiles;
CREATE TRIGGER profiles_release_member_ownership
  AFTER UPDATE OF account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.release_member_ownership();

-- ============================================================
-- 3. CONVERSATIONS LIVE ON A NUMBER
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- Backfill without touching updated_at (it drives "recent activity"
-- ordering in the inbox; a schema change must not reshuffle it).
ALTER TABLE conversations DISABLE TRIGGER set_updated_at;

UPDATE conversations c
SET whatsapp_config_id = (
  SELECT w.id
  FROM whatsapp_config w
  WHERE w.account_id = c.account_id
  ORDER BY w.is_primary DESC, w.created_at, w.id
  LIMIT 1
)
WHERE c.whatsapp_config_id IS NULL;

ALTER TABLE conversations ENABLE TRIGGER set_updated_at;

-- One thread per (account, contact, number). NULL numbers (a number
-- that was deleted afterwards) are distinct under a plain unique
-- index, so orphaned history never blocks a delete or a re-connect.
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_number
  ON conversations (account_id, contact_id, whatsapp_config_id);

CREATE INDEX IF NOT EXISTS idx_conversations_config
  ON conversations (whatsapp_config_id);

-- A conversation can only live on a number of its own account.
CREATE OR REPLACE FUNCTION public.enforce_conversation_number_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.whatsapp_config_id IS NOT DISTINCT FROM OLD.whatsapp_config_id
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE id = NEW.whatsapp_config_id
      AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'The WhatsApp number does not belong to this account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_conversation_number_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversations_number_account ON conversations;
CREATE TRIGGER conversations_number_account
  BEFORE INSERT OR UPDATE OF whatsapp_config_id, account_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_conversation_number_account();

-- ---- broadcasts remember which number sent them -----------------
-- A resume ("retry failed") must go out from the SAME number as the
-- original pass, so the sending number is frozen on the broadcast.
-- NULL (legacy rows) resolves to the account's primary number.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
    REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- ============================================================
-- 4. LEAD FIELDS ON THE SHARED CONTACT
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS lead_owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_lead_status_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_lead_status_check
  CHECK (lead_status IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost'));

CREATE INDEX IF NOT EXISTS idx_contacts_account_lead_status
  ON contacts (account_id, lead_status);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_owner
  ON contacts (account_id, lead_owner_id)
  WHERE lead_owner_id IS NOT NULL;

-- A lead owner must be a member of the contact's account (same shape
-- as the conversation-assignee check in 055). An invalid owner is
-- dropped rather than rejected so bulk imports never fail on it.
CREATE OR REPLACE FUNCTION public.enforce_contact_lead_owner_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lead_owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.lead_owner_id IS NOT DISTINCT FROM OLD.lead_owner_id
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
  THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = NEW.lead_owner_id
      AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'The lead owner must be a member of this account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_contact_lead_owner_membership() OWNER TO postgres;

DROP TRIGGER IF EXISTS contacts_lead_owner_membership ON contacts;
CREATE TRIGGER contacts_lead_owner_membership
  BEFORE INSERT OR UPDATE OF lead_owner_id, account_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contact_lead_owner_membership();

-- ============================================================
-- 5. CONVERSATION VISIBILITY (RLS)
--
-- can_access_conversation() is the single rule. Members are checked
-- by is_account_member() as before; this adds "which threads".
--
--   owner / admin / viewer  → every thread in the account
--   agent, visibility='all' → every thread (historical behaviour)
--   agent, visibility='own' → threads on a number they own, or
--                             threads assigned to them
--
-- SECURITY DEFINER so the body can read profiles / accounts /
-- whatsapp_config without recursive RLS evaluation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_access_conversation(
  p_account_id UUID,
  p_config_id UUID,
  p_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = p_account_id
      AND (
        p.account_role IN ('owner', 'admin', 'viewer')
        OR a.agent_visibility = 'all'
        OR p_assigned_agent_id = p.user_id
        OR EXISTS (
          SELECT 1 FROM whatsapp_config w
          WHERE w.id = p_config_id
            AND w.account_id = p_account_id
            AND w.owner_user_id = p.user_id
        )
      )
  );
$$;

ALTER FUNCTION public.can_access_conversation(UUID, UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID, UUID, UUID)
  TO authenticated, service_role;

-- ---- conversations ---------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT USING (
  is_account_member(account_id)
  AND can_access_conversation(account_id, whatsapp_config_id, assigned_agent_id)
);
CREATE POLICY conversations_insert ON conversations FOR INSERT WITH CHECK (
  is_account_member(account_id, 'agent')
  AND can_access_conversation(account_id, whatsapp_config_id, assigned_agent_id)
);
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (
  is_account_member(account_id, 'agent')
  AND can_access_conversation(account_id, whatsapp_config_id, assigned_agent_id)
);
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (
  is_account_member(account_id, 'agent')
  AND can_access_conversation(account_id, whatsapp_config_id, assigned_agent_id)
);

-- ---- messages --------------------------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id)
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
);

-- ---- message_reactions -----------------------------------------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;

CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id)
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
);
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, c.assigned_agent_id)
  )
);

-- ============================================================
-- 6. ADMIN OVERVIEW — team_overview(days)
--
-- One round trip for the monitoring screen. Admin+ only (checked
-- inside; SECURITY DEFINER so it can aggregate every thread
-- regardless of the caller's own visibility).
--
-- Returns:
--   {
--     "windowDays": 30,
--     "visibility": "all" | "own",
--     "numbers": [ { id, label, phoneNumberId, status, isPrimary,
--                    ownerUserId, ownerName, conversations, open,
--                    unread, awaitingReply, oldestWaitingAt,
--                    inbound, outbound, lastMessageAt } ],
--     "members": [ { userId, name, email, role, numbers,
--                    assignedConversations, leadsOwned,
--                    messagesSent } ],
--     "leads":   { total, byStatus: { new: n, ... },
--                  unowned, bySource: [ { configId, label, count } ] },
--     "unassignedOpenConversations": n
--   }
-- ============================================================
CREATE OR REPLACE FUNCTION public.team_overview(p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account    UUID;
  v_role       account_role_enum;
  v_days       INTEGER := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));
  v_since      TIMESTAMPTZ;
  v_visibility TEXT;
  v_numbers    JSONB;
  v_members    JSONB;
  v_leads      JSONB;
  v_unassigned INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_account, v_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  v_since := NOW() - make_interval(days => v_days);
  SELECT agent_visibility INTO v_visibility FROM accounts WHERE id = v_account;

  -- ---- numbers -------------------------------------------------
  SELECT COALESCE(jsonb_agg(n ORDER BY (n->>'isPrimary')::boolean DESC, n->>'label'), '[]'::jsonb)
  INTO v_numbers
  FROM (
    SELECT jsonb_build_object(
      'id',              w.id,
      'label',           COALESCE(NULLIF(w.label, ''), w.phone_number_id),
      'phoneNumberId',   w.phone_number_id,
      'status',          w.status,
      'isPrimary',       w.is_primary,
      'ownerUserId',     w.owner_user_id,
      'ownerName',       COALESCE(NULLIF(op.full_name, ''), op.email),
      'conversations',   COALESCE(cs.total, 0),
      'open',            COALESCE(cs.open_count, 0),
      'unread',          COALESCE(cs.unread, 0),
      'awaitingReply',   COALESCE(cs.awaiting, 0),
      'oldestWaitingAt', cs.oldest_waiting,
      'inbound',         COALESCE(ms.inbound, 0),
      'outbound',        COALESCE(ms.outbound, 0),
      'lastMessageAt',   cs.last_message_at
    ) AS n
    FROM whatsapp_config w
    LEFT JOIN profiles op ON op.user_id = w.owner_user_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)                                                    AS total,
        count(*) FILTER (WHERE c.status = 'open')                   AS open_count,
        COALESCE(sum(c.unread_count), 0)                            AS unread,
        count(*) FILTER (
          WHERE c.status <> 'closed'
            AND c.last_inbound_at IS NOT NULL
            AND (c.last_reply_at IS NULL OR c.last_reply_at < c.last_inbound_at)
        )                                                           AS awaiting,
        min(c.last_inbound_at) FILTER (
          WHERE c.status <> 'closed'
            AND c.last_inbound_at IS NOT NULL
            AND (c.last_reply_at IS NULL OR c.last_reply_at < c.last_inbound_at)
        )                                                           AS oldest_waiting,
        max(c.last_message_at)                                      AS last_message_at
      FROM conversations c
      WHERE c.account_id = v_account AND c.whatsapp_config_id = w.id
    ) cs ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE m.sender_type = 'customer')                  AS inbound,
        count(*) FILTER (WHERE m.sender_type IN ('agent', 'bot'))           AS outbound
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = v_account
        AND c.whatsapp_config_id = w.id
        AND m.created_at >= v_since
    ) ms ON TRUE
    WHERE w.account_id = v_account
  ) q;

  -- ---- members -------------------------------------------------
  SELECT COALESCE(jsonb_agg(mm ORDER BY mm->>'name'), '[]'::jsonb)
  INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'userId',                p.user_id,
      'name',                  COALESCE(NULLIF(p.full_name, ''), p.email),
      'email',                 p.email,
      'role',                  p.account_role,
      'numbers',               (SELECT count(*) FROM whatsapp_config w
                                WHERE w.account_id = v_account AND w.owner_user_id = p.user_id),
      'assignedConversations', (SELECT count(*) FROM conversations c
                                WHERE c.account_id = v_account
                                  AND c.assigned_agent_id = p.user_id
                                  AND c.status <> 'closed'),
      'leadsOwned',            (SELECT count(*) FROM contacts ct
                                WHERE ct.account_id = v_account AND ct.lead_owner_id = p.user_id),
      'messagesSent',          (SELECT count(*) FROM messages m
                                JOIN conversations c ON c.id = m.conversation_id
                                WHERE c.account_id = v_account
                                  AND m.sender_type = 'agent'
                                  AND m.sender_id = p.user_id
                                  AND m.created_at >= v_since)
    ) AS mm
    FROM profiles p
    WHERE p.account_id = v_account
  ) q;

  -- ---- leads ---------------------------------------------------
  SELECT jsonb_build_object(
    'total',    (SELECT count(*) FROM contacts WHERE account_id = v_account),
    'unowned',  (SELECT count(*) FROM contacts WHERE account_id = v_account AND lead_owner_id IS NULL),
    'byStatus', COALESCE((
      SELECT jsonb_object_agg(s.lead_status, s.cnt)
      FROM (
        SELECT lead_status, count(*) AS cnt
        FROM contacts
        WHERE account_id = v_account
        GROUP BY lead_status
      ) s
    ), '{}'::jsonb),
    'bySource', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'configId', s.source_config_id,
               'label',    COALESCE(NULLIF(w.label, ''), w.phone_number_id),
               'count',    s.cnt
             ) ORDER BY s.cnt DESC)
      FROM (
        SELECT source_config_id, count(*) AS cnt
        FROM contacts
        WHERE account_id = v_account AND source_config_id IS NOT NULL
        GROUP BY source_config_id
      ) s
      JOIN whatsapp_config w ON w.id = s.source_config_id
    ), '[]'::jsonb)
  ) INTO v_leads;

  SELECT count(*) INTO v_unassigned
  FROM conversations
  WHERE account_id = v_account
    AND status = 'open'
    AND assigned_agent_id IS NULL;

  RETURN jsonb_build_object(
    'windowDays',                  v_days,
    'visibility',                  v_visibility,
    'numbers',                     v_numbers,
    'members',                     v_members,
    'leads',                       v_leads,
    'unassignedOpenConversations', v_unassigned
  );
END;
$$;

ALTER FUNCTION public.team_overview(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_overview(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.team_overview(INTEGER) TO authenticated;
