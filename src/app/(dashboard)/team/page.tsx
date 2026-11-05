"use client";

// Admin Team Overview (migration 060 → team_overview RPC): per-number and
// per-member activity plus the shared lead funnel, in one screen.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { LEAD_STATUSES } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface NumberStat {
  id: string;
  label: string;
  status: string;
  isPrimary: boolean;
  ownerName: string | null;
  conversations: number;
  open: number;
  unread: number;
  awaitingReply: number;
  inbound: number;
  outbound: number;
  lastMessageAt: string | null;
}
interface MemberStat {
  userId: string;
  name: string;
  role: string;
  numbers: number;
  assignedConversations: number;
  leadsOwned: number;
  messagesSent: number;
}
interface Overview {
  windowDays: number;
  visibility: string;
  numbers: NumberStat[] | null;
  members: MemberStat[] | null;
  leads: {
    total: number;
    unowned: number;
    byStatus: Record<string, number>;
    bySource: { configId: string; label: string; count: number }[] | null;
  };
  unassignedOpenConversations: number;
}

const DAY_OPTIONS = [7, 30, 90];

export default function TeamOverviewPage() {
  const t = useTranslations("Team");
  const tStatus = useTranslations("Contacts.lead.statuses");
  const { canManageMembers, profileLoading } = useAuth();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profileLoading || !canManageMembers) return;
    let cancelled = false;
    setData(null);
    fetch(`/api/account/team-overview?days=${days}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) setError(d.error || t("loadFailed"));
        else {
          setError(null);
          setData(d);
        }
      })
      .catch(() => !cancelled && setError(t("loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [days, canManageMembers, profileLoading, t]);

  if (profileLoading) return null;
  if (!canManageMembers) {
    return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;
  }
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;

  const numbers = data.numbers ?? [];
  const members = data.members ?? [];
  const sources = data.leads.bySource ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md border px-3 py-1 text-sm ${d === days ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {t("lastDays", { days: d })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("totalLeads")} value={data.leads.total} />
        <Stat label={t("unownedLeads")} value={data.leads.unowned} />
        <Stat label={t("unassignedOpen")} value={data.unassignedOpenConversations} />
        <Stat label={t("numbers")} value={numbers.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("funnel")}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {LEAD_STATUSES.map((s) => (
            <Stat key={s} label={tStatus(s)} value={data.leads.byStatus[s] ?? 0} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("byNumber")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">{t("number")}</th>
                <th className="pr-3">{t("owner")}</th>
                <th className="pr-3">{t("conversations")}</th>
                <th className="pr-3">{t("open")}</th>
                <th className="pr-3">{t("awaiting")}</th>
                <th className="pr-3">{t("inbound")}</th>
                <th className="pr-3">{t("outbound")}</th>
                <th>{t("leadsFrom")}</th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id} className="border-t">
                  <td className="py-2 pr-3 font-medium">
                    {n.label} {n.isPrimary ? <span className="text-xs text-muted-foreground">({t("default")})</span> : null}
                  </td>
                  <td className="pr-3">{n.ownerName ?? "—"}</td>
                  <td className="pr-3">{n.conversations}</td>
                  <td className="pr-3">{n.open}</td>
                  <td className="pr-3">{n.awaitingReply}</td>
                  <td className="pr-3">{n.inbound}</td>
                  <td className="pr-3">{n.outbound}</td>
                  <td>{sources.find((s) => s.configId === n.id)?.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("byMember")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">{t("member")}</th>
                <th className="pr-3">{t("role")}</th>
                <th className="pr-3">{t("numbers")}</th>
                <th className="pr-3">{t("assigned")}</th>
                <th className="pr-3">{t("leadsOwned")}</th>
                <th>{t("messagesSent")}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-t">
                  <td className="py-2 pr-3 font-medium">{m.name}</td>
                  <td className="pr-3">{m.role}</td>
                  <td className="pr-3">{m.numbers}</td>
                  <td className="pr-3">{m.assignedConversations}</td>
                  <td className="pr-3">{m.leadsOwned}</td>
                  <td>{m.messagesSent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
