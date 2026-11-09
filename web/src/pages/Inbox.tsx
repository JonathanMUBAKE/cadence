import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AtSign, BellRing, CheckCheck, CircleCheck, FileText, MessageSquare, Sparkles, UserPlus } from "lucide-react";
import { Avatar, Button, Empty, cn } from "@/components/ui";
import { ApprovalCard } from "@/components/ai";
import { useApprovals, useNotifications, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { Notification } from "@/lib/types";

const KIND_ICON: Record<string, typeof AtSign> = { mention: AtSign, comment: MessageSquare, assigned: UserPlus, "task.completed": CircleCheck, approval: Sparkles, "project.update": FileText, report: FileText };

export function InboxPage() {
  const { data: notifs } = useNotifications();
  const { data: approvals } = useApprovals();
  const users = useUserMap();
  const shell = useShell();
  const nav = useNavigate();
  const qc = useQueryClient();
  const read = async (ids: string[] | "all") => { await api.post("/api/notifications/read", ids === "all" ? { all: true } : { ids }); qc.invalidateQueries({ queryKey: ["notifications"] }); };
  const open = (n: Notification) => {
    if (!n.read) read([n.id]);
    if (n.kind === "report") nav(n.project_id ? `/projects/${n.project_id}/reports` : "/reports");
    else if (n.task_id) shell.openTask(n.task_id);
  };
  const list = (notifs ?? []).filter((n) => n.kind !== "approval" || !n.read);
  const unread = list.filter((n) => !n.read).length;

  return (
    <div className="mx-auto max-w-[860px] px-4 pb-16 pt-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Boîte de réception</h1>
          <p className="mt-1 text-[13px] text-muted">{unread ? `${unread} non lue(s)` : "Tout est lu."}</p>
        </div>
        {unread > 0 && <Button size="sm" className="ml-auto" icon={<CheckCheck className="size-3.5" />} onClick={() => read("all")}>Tout marquer comme lu</Button>}
      </header>

      {!!approvals?.length && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Sparkles className="size-4 text-ai-fg" />Validations demandées par l'IA</h2>
          <div className="space-y-2.5">{approvals.map((a) => (
            <div key={a.id}>
              <ApprovalCard a={a} />
              {a.task_id && <button onClick={() => shell.openTask(a.task_id!)} className="ml-12 mt-1 text-[12px] text-muted hover:text-fg">Voir la tâche →</button>}
            </div>
          ))}</div>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
        {list.length === 0 && <Empty icon={<BellRing className="size-8" />} title="Rien de nouveau">Les mentions, assignations et demandes de validation arrivent ici.</Empty>}
        {list.map((n) => {
          const Icon = KIND_ICON[n.kind] ?? BellRing;
          const actor = n.actor_id ? users.get(n.actor_id) : null;
          return (
            <button key={n.id} onClick={() => open(n)} className={cn("flex w-full items-start gap-3 border-b border-line px-4 py-3.5 text-left last:border-b-0 hover:bg-hover", !n.read && "bg-ai-soft/30")}>
              <div className="relative"><Avatar user={actor} size={30} /><span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-panel bg-raised text-muted"><Icon className="size-2.5" /></span></div>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13.5px] leading-snug", !n.read && "font-medium")}>{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{n.body}</p>}
                <p className="mt-1 text-[11.5px] text-faint">{ago(n.created_at)}</p>
              </div>
              {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-ai" />}
            </button>
          );
        })}
      </section>
    </div>
  );
}
