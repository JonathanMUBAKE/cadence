import { useMemo } from "react";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { Sparkles } from "lucide-react";
import { Avatar, Button, Markdown, Spinner, cn } from "@/components/ui";
import { useProjectActivity, useProjectUpdates, useStats, useUserMap } from "@/lib/hooks";
import { STATUS, ago, priorityMeta } from "@/lib/format";
import type { ProjectStatus } from "@/lib/types";
import type { ViewProps } from "@/pages/Project";

export function DashboardView({ project, canEdit, onStatusUpdate }: ViewProps & { onStatusUpdate: () => void }) {
  const { data: s } = useStats(project.id);
  const { data: updates } = useProjectUpdates(project.id);
  const { data: activity } = useProjectActivity(project.id);
  const users = useUserMap();
  if (!s)
    return (
      <div className="flex h-48 items-center justify-center">
        <Spinner />
      </div>
    );
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const latest = updates?.[0];

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Avancement" value={`${pct} %`} sub={`${s.done} sur ${s.total} tâches`} bar={pct / 100} />
        <Kpi label="En retard" value={s.overdue} sub="à débloquer" tone={s.overdue ? "danger" : undefined} />
        <Kpi label="Cette semaine" value={s.due_this_week} sub="échéances à venir" />
        <Kpi
          label="Sans responsable"
          value={s.unassigned}
          sub="tâches ouvertes"
          tone={s.unassigned ? "warning" : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Progression sur 14 jours" hint="Tâches terminées cumulées, face au périmètre total">
          <Burnup data={s.burnup} />
        </Panel>
        <Panel
          title="Dernier point d'avancement"
          action={
            canEdit ? (
              <Button size="sm" variant="ai" icon={<Sparkles className="size-3.5" />} onClick={onStatusUpdate}>
                Générer
              </Button>
            ) : undefined
          }
        >
          {latest ? (
            <div>
              <div className="flex items-center gap-2">
                <span
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium"
                  style={{
                    background: STATUS[latest.data.status as ProjectStatus].soft,
                    color: STATUS[latest.data.status as ProjectStatus].color,
                  }}
                >
                  <span className="size-1.5 rounded-full bg-current" />
                  {STATUS[latest.data.status as ProjectStatus].label}
                </span>
                <span className="text-[12px] text-faint">
                  {users.get(latest.actor_id)?.name} · {ago(latest.created_at)}
                </span>
              </div>
              <p className="mt-2 text-[15px] font-semibold leading-snug">{latest.data.headline}</p>
              <p className="mt-1 text-[13px] text-muted">{latest.data.summary}</p>
              {latest.data.risks.length > 0 && (
                <>
                  <p className="mt-3 text-[11.5px] font-medium uppercase tracking-wider text-faint">Risques</p>
                  <Markdown className="text-[13px]" text={latest.data.risks.map((r) => `- ${r}`).join("\n")} />
                </>
              )}
              {latest.data.next_steps.length > 0 && (
                <>
                  <p className="mt-3 text-[11.5px] font-medium uppercase tracking-wider text-faint">
                    Prochaines étapes
                  </p>
                  <Markdown className="text-[13px]" text={latest.data.next_steps.map((r) => `- ${r}`).join("\n")} />
                </>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              Aucun point publié. L'IA peut en rédiger un à partir des tâches et de l'activité récente.
            </p>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Par section">
          <div className="space-y-2.5">
            {s.bySection.map((x) => {
              const total = x.open + x.done || 1;
              const max = Math.max(...s.bySection.map((y) => y.open + y.done), 1);
              return (
                <div key={x.id}>
                  <div className="mb-1 flex justify-between text-[12.5px]">
                    <span>{x.name}</span>
                    <span className="tabular text-faint">{x.open + x.done}</span>
                  </div>
                  <div
                    className="flex h-2 overflow-hidden rounded-full bg-hover"
                    style={{ width: `${(total / max) * 100}%` }}
                  >
                    <div className="h-full bg-success" style={{ width: `${(x.done / total) * 100}%` }} />
                    <div
                      className="h-full"
                      style={{ width: `${(x.open / total) * 100}%`, background: project.color, opacity: 0.85 }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex gap-3 text-[11.5px] text-faint">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-success" />
              Terminées
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm" style={{ background: project.color }} />
              Ouvertes
            </span>
          </div>
        </Panel>
        <Panel title="Charge par personne">
          <div className="space-y-2">
            {s.byAssignee
              .filter((a) => a.open + a.done > 0)
              .map((a) => {
                const u = a.user_id ? users.get(a.user_id) : null;
                const max = Math.max(...s.byAssignee.map((y) => y.open), 1);
                return (
                  <div key={a.user_id ?? "none"} className="flex items-center gap-2.5">
                    <Avatar user={u} size={22} />
                    <span className="w-24 truncate text-[12.5px]">{u?.name.split(" ")[0] ?? "Personne"}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-hover">
                      <div className="h-full rounded-full bg-fg/80" style={{ width: `${(a.open / max) * 100}%` }} />
                    </div>
                    <span className="w-14 text-right text-[12px] tabular text-muted">
                      {a.open}
                      {a.overdue > 0 && <span className="text-danger"> · {a.overdue}</span>}
                    </span>
                  </div>
                );
              })}
          </div>
          <p className="mt-3 text-[11.5px] text-faint">
            Tâches ouvertes · <span className="text-danger">en retard</span>
          </p>
        </Panel>
        <Panel title="Priorités ouvertes">
          <Donut
            parts={s.byPriority
              .filter((p) => p.open > 0)
              .map((p) => ({
                label: priorityMeta(p.priority).label,
                value: p.open,
                color: p.priority === "none" ? "var(--line-strong)" : priorityMeta(p.priority).color,
              }))}
          />
        </Panel>
      </div>

      <Panel title="Activité récente">
        <ol className="space-y-2.5">
          {activity?.slice(0, 12).map((a) => (
            <li key={a.id} className="flex items-center gap-2.5 text-[13px]">
              <Avatar user={users.get(a.actor_id)} size={20} />
              <span className="min-w-0 flex-1 truncate text-muted">
                <span className="font-medium text-fg">{users.get(a.actor_id)?.name}</span> {describe(a.kind, a.data)}
              </span>
              <span className="shrink-0 text-[12px] text-faint">{ago(a.created_at)}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function describe(kind: string, d: Record<string, unknown>) {
  const m: Record<string, string> = {
    "task.created": `a créé « ${d.title ?? "une tâche"} »`,
    "task.completed": d.to ? "a terminé une tâche" : "a rouvert une tâche",
    "comment.created": "a commenté",
    "task.assignee_id": "a réassigné une tâche",
    "task.section_id": "a déplacé une tâche",
    "task.due_on": "a changé une échéance",
    "project.update": "a publié un point d'avancement",
    "ai.approved": `a autorisé : ${d.summary ?? ""}`,
    "ai.rejected": `a refusé : ${d.summary ?? ""}`,
    "project.status": "a changé le statut du projet",
  };
  return m[kind] ?? kind.replace("task.", "a modifié ");
}

function Kpi({
  label,
  value,
  sub,
  tone,
  bar,
}: {
  label: string;
  value: string | number;
  sub: string;
  tone?: "danger" | "warning";
  bar?: number;
}) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.03em] tabular",
          tone === "danger" && "text-danger",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-faint">{sub}</p>
      {bar !== undefined && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-success" style={{ width: `${bar * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-start gap-2">
        <div className="flex-1">
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {hint && <p className="text-[12px] text-faint">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Burnup({ data }: { data: { day: string; done: number; total: number }[] }) {
  const W = 640,
    H = 220,
    P = { l: 30, r: 12, t: 12, b: 26 };
  const max = Math.max(...data.map((d) => d.total), 1);
  const nice = Math.ceil(max / 5) * 5;
  const x = (i: number) => P.l + (i / (data.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / nice) * (H - P.t - P.b);
  const line = (k: "done" | "total") => data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d[k])}`).join(" ");
  const area = `${line("done")} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const ticks = [0, nice / 2, nice];
  const last = data[data.length - 1];
  return useMemo(
    () => (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Courbe de progression">
        <defs>
          <linearGradient id="bu" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--success)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--success)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={P.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--faint)">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          i % 3 === 0 || i === data.length - 1 ? (
            <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--faint)">
              {format(parseISO(d.day), "d MMM", { locale: fr })}
            </text>
          ) : null,
        )}
        <path d={area} fill="url(#bu)" />
        <path d={line("total")} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4 4" />
        <path d={line("done")} fill="none" stroke="var(--success)" strokeWidth="2.25" strokeLinejoin="round" />
        <circle
          cx={x(data.length - 1)}
          cy={y(last.done)}
          r="4"
          fill="var(--success)"
          stroke="var(--panel)"
          strokeWidth="2"
        />
        <text
          x={x(data.length - 1) - 8}
          y={y(last.done) - 10}
          textAnchor="end"
          fontSize="12"
          fontWeight="600"
          fill="var(--fg)"
        >
          {last.done} terminées
        </text>
        <text x={x(data.length - 1) - 8} y={y(last.total) - 8} textAnchor="end" fontSize="11" fill="var(--muted)">
          périmètre {last.total}
        </text>
      </svg>
    ),
    [data],
  );
}

function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 52,
    C = 2 * Math.PI * R;
  let acc = 0;
  if (!total) return <p className="text-[13px] text-muted">Aucune tâche ouverte.</p>;
  return (
    <div className="flex items-center gap-5">
      <svg width="132" height="132" viewBox="0 0 132 132" className="-rotate-90 shrink-0">
        <circle cx="66" cy="66" r={R} fill="none" stroke="var(--hover)" strokeWidth="14" />
        {parts.map((p) => {
          const len = (p.value / total) * C;
          const el = (
            <circle
              key={p.label}
              cx="66"
              cy="66"
              r={R}
              fill="none"
              stroke={p.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, len - 2)} ${C}`}
              strokeDashoffset={-acc}
            />
          );
          acc += len;
          return el;
        })}
      </svg>
      <ul className="space-y-1.5 text-[12.5px]">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
            <span className="w-16">{p.label}</span>
            <span className="tabular text-muted">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
