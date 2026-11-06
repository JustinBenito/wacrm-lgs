'use client';

// Settings → WhatsApp → "Team numbers" (migration 060).
//
// One row per connected WhatsApp number: who owns it, whether it is the
// account default, and whether the inbox is shared or per-rep. Admins add,
// reassign, rename and remove numbers here; everyone else gets a read-only list.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Star, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface NumberRow {
  id: string;
  label: string | null;
  phone_number_id: string;
  status: string;
  is_primary: boolean;
  owner_user_id: string | null;
}
interface MemberOpt {
  user_id: string;
  full_name: string;
  email: string | null;
}

const EMPTY = { label: '', phone_number_id: '', waba_id: '', access_token: '', pin: '', owner: '' };

export function NumbersManager() {
  const t = useTranslations('Settings.numbers');
  const { canEditSettings } = useAuth();
  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [members, setMembers] = useState<MemberOpt[]>([]);
  const [visibility, setVisibility] = useState<'all' | 'own'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    try {
      const [nres, mres] = await Promise.all([
        fetch('/api/whatsapp/numbers', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      if (nres.ok) {
        const d = await nres.json();
        setNumbers(d.numbers);
        setVisibility(d.visibility);
      }
      if (mres.ok) setMembers((await mres.json()).members);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const memberName = (id: string | null) => {
    if (!id) return t('unassigned');
    const m = members.find((x) => x.user_id === id);
    return m ? m.full_name || m.email || id : t('unassigned');
  };

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      const res = await fetch(`/api/whatsapp/numbers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(d.error || t('saveFailed'));
      else await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(n: NumberRow) {
    if (!window.confirm(t('confirmRemove', { name: n.label || n.phone_number_id }))) return;
    setBusy(n.id);
    try {
      const res = await fetch(`/api/whatsapp/config?id=${n.id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(d.error || t('saveFailed'));
      else await load();
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setAdding(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: form.phone_number_id.trim(),
          waba_id: form.waba_id.trim(),
          access_token: form.access_token.trim(),
          pin: form.pin.trim() || undefined,
          label: form.label.trim() || undefined,
          owner_user_id: form.owner || null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || t('saveFailed'));
        return;
      }
      toast.success(t('added'));
      setForm(EMPTY);
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function setMode(mode: 'all' | 'own') {
    const prev = visibility;
    setVisibility(mode);
    const res = await fetch('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_visibility: mode }),
    });
    if (!res.ok) {
      setVisibility(prev);
      toast.error(t('saveFailed'));
    }
  }

  if (loading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {numbers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {numbers.map((n) => (
              <li key={n.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {n.label || n.phone_number_id}
                    {n.is_primary ? (
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                        <Star className="size-3" /> {t('primary')}
                      </span>
                    ) : null}
                    <span className={n.status === 'connected' ? 'text-xs text-green-600' : 'text-xs text-amber-600'}>
                      {n.status}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('owner')}: {memberName(n.owner_user_id)} · ID {n.phone_number_id}
                  </div>
                </div>
                {canEditSettings ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t('owner')}
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      value={n.owner_user_id ?? ''}
                      disabled={busy === n.id}
                      onChange={(e) => patch(n.id, { owner_user_id: e.target.value || null })}
                    >
                      <option value="">{t('unassigned')}</option>
                      {members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </option>
                      ))}
                    </select>
                    {!n.is_primary ? (
                      <Button size="sm" variant="outline" disabled={busy === n.id} onClick={() => patch(n.id, { is_primary: true })}>
                        {t('makePrimary')}
                      </Button>
                    ) : null}
                    <Button size="icon" variant="ghost" aria-label={t('remove')} disabled={busy === n.id} onClick={() => remove(n)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEditSettings ? (
          <>
            <div className="rounded-md border p-3">
              <div className="mb-2 text-sm font-medium">{t('visibilityTitle')}</div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={visibility === 'all' ? 'default' : 'outline'} onClick={() => setMode('all')}>
                  {t('visibilityAll')}
                </Button>
                <Button size="sm" variant={visibility === 'own' ? 'default' : 'outline'} onClick={() => setMode('own')}>
                  {t('visibilityOwn')}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {visibility === 'all' ? t('visibilityAllHelp') : t('visibilityOwnHelp')}
              </p>
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">{t('addTitle')}</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="num-label">{t('label')}</Label>
                  <Input id="num-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Priya – Sales" />
                </div>
                <div>
                  <Label htmlFor="num-owner">{t('owner')}</Label>
                  <select id="num-owner" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
                    <option value="">{t('unassigned')}</option>
                    {members.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.full_name || m.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="num-pid">Phone Number ID</Label>
                  <Input id="num-pid" inputMode="numeric" value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="num-waba">WABA ID</Label>
                  <Input id="num-waba" inputMode="numeric" value={form.waba_id} onChange={(e) => setForm({ ...form, waba_id: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="num-token">Access token</Label>
                  <Input id="num-token" type="password" autoComplete="off" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="num-pin">{t('pin')}</Label>
                  <Input id="num-pin" inputMode="numeric" maxLength={6} value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
                </div>
              </div>
              <Button onClick={add} disabled={adding || !form.phone_number_id || !form.access_token || !form.waba_id}>
                {adding ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}
                {t('add')}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
