import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CircleCheck, Download, FileBarChart, Info, Sparkles, Trash2 } from "lucide-react";
import { Avatar, Button, Chip, Empty, IconButton, Markdown, Spinner, cn } from "./ui";
import { useAgents, useAiStatus, useMe, useReport, useReports, useUserMap } from "@/lib/hooks";
import { STATUS, ago, shortDate } from "@/lib/format";
import { api } from "@/lib/api";
import type { Finding, Level, Report, ReportContent, ReportMetrics, ReportSummary, TaskRef } from "@/lib/types";

const PERIODS = [{ days: 7, label: "7 jours" }, { days: 30, label: "30 jours" }, { days: 90, label: "90 jours" }];
const LEVEL: Record<Level, { label: string; tone: "danger" | "warning" | "muted" }> = { high: { label: "Élevé", tone: "danger" }, medium: { label: "Moyen", tone: "warning" }, low: { label: "Faible", tone: "muted" } };
const PRIORITY_LABEL: Record<Level, string> = { high: "Priorité haute", medium: "Priorité moyenne", low: "Priorité basse" };
const CONFIDENCE: Record<"low" | "medium" | "high", string> = { low: "confiance faible", medium: "confiance moyenne", high: "confiance élevée" };
const HEALTH = { good: { label: "Sain", tone: "success" }, watch: { label: "À surveiller", tone: "warning" }, critical: { label: "Critique", tone: "danger" } } as const;
const percent = (v: number | null) => (v === null ? "n.d." : `${Math.round(v * 100)} %`);
const num = (v: number) => String(v).replace(".", ",");
const days = (v: number | null) => (v === null ? "n.d." : `${num(v)} j`);
const field = "h-9 rounded-lg border border-line bg-bg/60 px-2.5 text-[13px] text-fg outline-none focus:border-ai-line";

/** Génération et consultation des rapports : d'un projet si `projectId`, sinon du portefeuille. */
export function ReportsPanel({ projectId, canGenerate, agentIds }: { projectId: string | null; canGenerate: boolean; agentIds?: Set<string> }) {
  const { data: reports } = useReports(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const current = reports?.some((r) => r.id === selected) ? selected : reports?.[0]?.id ?? null;
  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-8">
      {canGenerate && <Generator projectId={projectId} agentIds={agentIds} onCreated={setSelected} />}
      {reports && !reports.length ? (
        <Empty icon={<FileBarChart className="size-6" />} title="Aucun rapport pour l'instant">
          {canGenerate ? "Choisissez un coéquipier et une période : il analyse les données et rédige le rapport." : "Les rapports générés par les éditeurs du projet apparaîtront ici."}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <ReportList reports={reports} selected={current} onSelect={setSelected} />
          {current ? <ReportDetail id={current} /> : <div className="flex h-48 items-center justify-center"><Spinner /></div>}
        </div>
      )}
    </div>
  );
}

function Generator({ projectId, agentIds, onCreated }: { projectId: string | null; agentIds?: Set<string>; onCreated: (id: string) => void }) {
  const { data: all } = useAgents();
  const { data: ai } = useAiStatus();
  const qc = useQueryClient();
  const agents = (all ?? []).filter((a) => !agentIds || agentIds.has(a.id));
  const [agent, setAgent] = useState("");
  const [period, setPeriod] = useState(30);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const agentId = agents.some((a) => a.id === agent) ? agent : agents[0]?.id ?? "";
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.post<Report>(projectId ? `/api/projects/${projectId}/reports` : "/api/reports", { agent_id: agentId, period_days: period, focus: focus.trim() || undefined });
      await qc.invalidateQueries({ queryKey: ["reports", projectId] });
      onCreated(r.id); setFocus("");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-ai-line bg-ai-soft/40 p-4 sm:p-5">
      <div className="flex items-center gap-2"><Sparkles className="size-4 text-ai-fg" /><h2 className="text-[14px] font-semibold">Nouveau rapport d'analyse</h2></div>
      <p className="mt-1 text-[13px] text-muted">Les chiffres sont calculés par Cadence sur les projets auxquels le coéquipier a accès. Il les interprète et rédige le rapport.{ai?.provider === "demo" && " Mode démo : le texte est produit par un modèle de règles, sans clé ANTHROPIC_API_KEY."}</p>
      {agents.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-warning"><AlertTriangle className="size-4 shrink-0" />Aucun coéquipier IA n'a accès{projectId ? " à ce projet : ajoutez-en un à ses membres." : " à vos projets."}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-[12px] text-muted">Rédigé par<select value={agentId} onChange={(e) => setAgent(e.target.value)} className={cn(field, "mt-1 block w-40")}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="text-[12px] text-muted">Période<select value={period} onChange={(e) => setPeriod(Number(e.target.value))} className={cn(field, "mt-1 block w-32")}>{PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}</select></label>
          <label className="min-w-[220px] flex-1 text-[12px] text-muted">Question à traiter (facultatif)<input value={focus} maxLength={1000} onChange={(e) => setFocus(e.target.value)} placeholder="Ex. : qu'est-ce qui menace la date de livraison ?" className={cn(field, "mt-1 block w-full")} /></label>
          <Button variant="ai" className="h-9" loading={busy} disabled={!agentId} icon={<Sparkles className="size-3.5" />} onClick={generate}>Générer</Button>
        </div>
      )}
    </section>
  );
}

function ReportList({ reports, selected, onSelect }: { reports?: ReportSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  const users = useUserMap();
  if (!reports) return <div className="flex h-32 items-center justify-center"><Spinner /></div>;
  return (
    <ul className="space-y-1.5 lg:max-h-[75vh] lg:overflow-y-auto">
      {reports.map((r) => (
        <li key={r.id}>
          <button onClick={() => onSelect(r.id)} className={cn("w-full rounded-xl border p-3 text-left transition-colors", r.id === selected ? "border-line-strong bg-active" : "border-line bg-panel hover:bg-hover")}>
            <span className="line-clamp-2 block text-[13px] font-medium leading-snug">{r.status === "generating" ? "Rédaction en cours…" : r.status === "failed" ? "Échec de la rédaction" : r.title}</span>
            <span className="mt-1.5 flex items-center gap-1.5 text-[12px] text-faint"><Avatar user={users.get(r.agent_id)} size={16} />{users.get(r.agent_id)?.name} · {r.period_days} j · {ago(r.created_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReportDetail({ id }: { id: string }) {
  const { data: r } = useReport(id);
  const { data: me } = useMe();
  const users = useUserMap();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [id]);
  if (!r) return <div className="flex h-48 items-center justify-center"><Spinner /></div>;
  const remove = () => api.del(`/api/reports/${r.id}`).then(() => { qc.invalidateQueries({ queryKey: ["reports"] }); toast.success("Rapport supprimé"); }, (e) => toast.error(e.message));
  const c = r.content;
  const agent = users.get(r.agent_id);
  return (
    <article className="min-w-0 space-y-5">
      <header className="rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-faint">
          {c && <span className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium" style={{ background: STATUS[c.status].soft, color: STATUS[c.status].color }}><span className="size-1.5 rounded-full bg-current" />{STATUS[c.status].label}</span>}
          <Avatar user={agent} size={18} /><span>{agent?.name} · du {shortDate(r.metrics.period.from)} au {shortDate(r.metrics.period.to)}</span>
          {r.provider === "demo" && <Chip>Mode démo</Chip>}
          <span className="ml-auto flex items-center gap-1">
            {c && <IconButton label="Télécharger en Markdown" onClick={() => download(r, c, agent?.name ?? "Coéquipier IA")}><Download className="size-4" /></IconButton>}
            {(r.created_by === me?.id || r.scope === "project") && (confirming
              ? <><Button size="sm" variant="danger" onClick={remove}>Confirmer</Button><Button size="sm" onClick={() => setConfirming(false)}>Annuler</Button></>
              : <IconButton label="Supprimer le rapport" onClick={() => setConfirming(true)}><Trash2 className="size-4" /></IconButton>)}
          </span>
        </div>
        {r.status === "generating" && <p className="mt-3 flex items-center gap-2 text-[14px] text-muted"><Spinner />{agent?.name} analyse les données et rédige le rapport…</p>}
        {r.status === "failed" && <p className="mt-3 flex items-center gap-2 text-[14px] text-danger"><AlertTriangle className="size-4 shrink-0" />{r.error ?? "La rédaction a échoué."} Les indicateurs ci-dessous restent valables.</p>}
        {c && <><h2 className="mt-3 text-[19px] font-semibold leading-snug tracking-[-0.01em]">{c.title}</h2><Markdown className="mt-2 text-[14px]" text={c.executive_summary} /></>}
        {r.focus && <div className="mt-3 rounded-lg bg-hover p-3 text-[13px]"><p className="font-medium">Question : {r.focus}</p>{c?.focus_answer && <Markdown className="mt-1 text-muted" text={c.focus_answer} />}</div>}
      </header>
      <Indicators m={r.metrics} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Tâches terminées par semaine"><WeeklyBars weeks={r.metrics.weekly} /></Panel>
        <Panel title="Constats chiffrés"><Findings items={r.metrics.findings} /></Panel>
      </div>
      {c && c.highlights.length > 0 && <Panel title="Points marquants"><Markdown className="text-[13.5px]" text={c.highlights.map((h) => `- ${h}`).join("\n")} /></Panel>}
      {c && c.risks.length > 0 && <Panel title="Risques"><Risks items={c.risks} /></Panel>}
      {c && c.recommendations.length > 0 && <Panel title="Recommandations"><Recommendations items={c.recommendations} /></Panel>}
      {r.metrics.scope === "portfolio" && <PortfolioTable m={r.metrics} />}
      <Panel title="Charge par personne">{c && <Markdown className="mb-3 text-[13.5px]" text={c.team_analysis} />}<Workload m={r.metrics} /></Panel>
      {r.metrics.overdue_tasks.length > 0 && <Panel title="Tâches en retard"><Tasks items={r.metrics.overdue_tasks} unit="de retard" /></Panel>}
      {r.metrics.stale_tasks.length > 0 && <Panel title="Tâches inactives"><Tasks items={r.metrics.stale_tasks} unit="sans activité" /></Panel>}
      {c && c.next_period_focus.length > 0 && <Panel title="Priorités de la période suivante"><Markdown className="text-[13.5px]" text={c.next_period_focus.map((h) => `- ${h}`).join("\n")} /></Panel>}
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-5"><h3 className="mb-3 text-[13.5px] font-semibold">{title}</h3>{children}</section>;
}

function Indicators({ m }: { m: ReportMetrics }) {
  const t = m.totals;
  const delta = t.completed_in_period - t.previous_completed;
  const tiles = [
    { label: "Terminées", value: t.completed_in_period, sub: `${delta >= 0 ? "+" : ""}${delta} par rapport à la période précédente` },
    { label: "Vélocité", value: num(t.velocity_per_week), sub: "tâches par semaine" },
    { label: "En retard", value: t.overdue, sub: t.overdue ? `maximum ${t.max_days_late} j` : "aucun retard", danger: t.overdue > 0 },
    { label: "À l'heure", value: percent(t.on_time_rate), sub: t.on_time_sample ? `sur ${t.on_time_sample} tâche(s) datée(s)` : "aucune tâche datée terminée" },
    { label: "Durée médiane", value: days(t.cycle_median_days), sub: t.cycle_sample ? `création → fin, ${t.cycle_sample} tâche(s)` : "pas assez de données" },
    m.scope === "project"
      ? { label: "Fin estimée", value: m.forecast.projected_end ? shortDate(m.forecast.projected_end) : "n.d.", sub: m.forecast.projected_end ? `${m.forecast.margin_days === null ? "sans échéance" : m.forecast.margin_days < 0 ? `${-m.forecast.margin_days} j après l'échéance` : `${m.forecast.margin_days} j de marge`}, ${CONFIDENCE[m.forecast.confidence]}` : "vélocité nulle", danger: (m.forecast.margin_days ?? 0) < 0 }
      : { label: "Inactives", value: t.stale, sub: "depuis plus de 14 jours" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {tiles.map((k) => (
        <div key={k.label} className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
          <p className="text-[12px] font-medium text-muted">{k.label}</p>
          <p className={cn("mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.03em] tabular", k.danger && "text-danger")}>{k.value}</p>
          <p className="mt-1.5 text-[12px] text-faint">{k.sub}</p>
        </div>
      ))}
    </div>
  );
}

function WeeklyBars({ weeks }: { weeks: ReportMetrics["weekly"] }) {
  const max = Math.max(...weeks.map((w) => w.completed), 1);
  const every = weeks.length > 6 ? 2 : 1;
  const label = (w: (typeof weeks)[number]) => `Semaine du ${shortDate(w.from)} : ${w.completed} terminée(s), ${w.created} créée(s)`;
  return (
    <div>
      <div className="relative flex h-32 items-end gap-0.5 border-b border-line-strong" role="img" aria-label={weeks.map(label).join(". ")}>
        {weeks.map((w) => (
          <div key={w.from} tabIndex={0} className="group relative flex h-full flex-1 items-end justify-center rounded-t outline-none hover:bg-hover focus-visible:bg-hover">
            <div className="w-full max-w-[28px] rounded-t-[4px] bg-success" style={{ height: `${(w.completed / max) * 88}%` }} />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden w-max max-w-[180px] -translate-x-1/2 rounded-md bg-fg px-2 py-1 text-[12px] text-bg shadow-md group-hover:block group-focus-visible:block">{label(w)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5 text-[11px] text-faint">{weeks.map((w, i) => <span key={w.from} className="flex-1 truncate text-center">{(weeks.length - 1 - i) % every === 0 ? shortDate(w.from) : ""}</span>)}</div>
      <details className="mt-2 text-[12.5px] text-muted">
        <summary className="cursor-pointer select-none text-[12px] text-faint hover:text-fg">Voir les données</summary>
        <table className="mt-2 w-full tabular"><thead className="text-left text-faint"><tr><th className="font-normal">Semaine du</th><th className="text-right font-normal">Terminées</th><th className="text-right font-normal">Créées</th></tr></thead>
          <tbody>{weeks.map((w) => <tr key={w.from}><td>{shortDate(w.from)}</td><td className="text-right">{w.completed}</td><td className="text-right">{w.created}</td></tr>)}</tbody></table>
      </details>
    </div>
  );
}

function Findings({ items }: { items: Finding[] }) {
  if (!items.length) return <p className="text-[13px] text-muted">Aucun signal notable sur cette période.</p>;
  return (
    <ul className="space-y-2 text-[13px]">
      {items.map((f) => (
        <li key={f.code + f.message} className="flex gap-2">
          {f.severity === "positive" ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : f.severity === "low" ? <Info className="mt-0.5 size-3.5 shrink-0 text-faint" /> : <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", f.severity === "high" ? "text-danger" : "text-warning")} />}
          <span>{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

function Risks({ items }: { items: ReportContent["risks"] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((x, i) => (
        <li key={i} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-center gap-2"><Chip tone={LEVEL[x.severity].tone}>{LEVEL[x.severity].label}</Chip><p className="text-[13.5px] font-medium">{x.title}</p></div>
          <Markdown className="mt-1 text-[13px] text-muted" text={x.evidence} />
          <Markdown className="mt-1 text-[13px]" text={`**À faire :** ${x.recommendation}`} />
        </li>
      ))}
    </ul>
  );
}

function Recommendations({ items }: { items: ReportContent["recommendations"] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((x, i) => (
        <li key={i} className="flex flex-wrap items-start gap-2 text-[13.5px]">
          <span className="min-w-0 flex-1 basis-60"><Markdown text={x.action} /></span>
          {x.owner && <span className="text-[12px] text-muted">{x.owner}</span>}
          <Chip tone={LEVEL[x.priority].tone}>{PRIORITY_LABEL[x.priority]}</Chip>
        </li>
      ))}
    </ul>
  );
}

const th = "pb-2 text-right text-[12px] font-normal text-faint";
const td = "py-1.5 text-right tabular";

function Workload({ m }: { m: ReportMetrics }) {
  const rows = m.workload.filter((w) => w.open + w.completed_in_period > 0);
  if (!rows.length) return <p className="text-[13px] text-muted">Aucune tâche attribuée.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-[13px]">
        <thead><tr><th className={cn(th, "text-left")}>Personne</th><th className={th}>Ouvertes</th><th className={th}>En retard</th><th className={th}>Priorité haute</th><th className={th}>Terminées</th></tr></thead>
        <tbody className="divide-y divide-line">{rows.map((w) => <tr key={w.user_id ?? "none"}><td className="py-1.5">{w.name}{w.is_ai && <span className="ml-1.5 text-[11px] text-ai-fg">IA</span>}</td><td className={td}>{w.open}</td><td className={cn(td, w.overdue > 0 && "text-danger")}>{w.overdue}</td><td className={td}>{w.high_priority_open}</td><td className={td}>{w.completed_in_period}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function PortfolioTable({ m }: { m: Extract<ReportMetrics, { scope: "portfolio" }> }) {
  return (
    <Panel title="Projets analysés">
      {m.excluded_projects > 0 && <p className="mb-3 flex items-center gap-2 text-[12.5px] text-warning"><Info className="size-3.5 shrink-0" />Projets non inclus : {m.excluded_projects}. Ce coéquipier n'y a pas accès.</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead><tr><th className={cn(th, "text-left")}>Projet</th><th className={cn(th, "text-left")}>État</th><th className={th}>Ouvertes</th><th className={th}>En retard</th><th className={th}>Par semaine</th><th className={th}>Marge</th></tr></thead>
          <tbody className="divide-y divide-line">{m.projects.map((p) => <tr key={p.project_id}><td className="py-1.5"><span className="mr-1.5 font-mono text-[12px] text-faint">{p.key}</span>{p.name}</td><td className="py-1.5"><Chip tone={HEALTH[p.health].tone}>{HEALTH[p.health].label}</Chip></td><td className={td}>{p.open}</td><td className={cn(td, p.overdue > 0 && "text-danger")}>{p.overdue}</td><td className={td}>{num(p.velocity_per_week)}</td><td className={cn(td, (p.margin_days ?? 0) < 0 && "text-danger")}>{days(p.margin_days)}</td></tr>)}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function Tasks({ items, unit }: { items: TaskRef[]; unit: string }) {
  return (
    <ul className="space-y-1.5 text-[13px]">
      {items.map((t) => <li key={t.key} className="flex items-baseline gap-2"><span className="font-mono text-[12px] text-ai-fg">{t.key}</span><span className="min-w-0 flex-1 truncate">{t.title}</span><span className="hidden shrink-0 text-[12px] text-faint sm:inline">{t.assignee ?? "Sans responsable"}</span><span className="shrink-0 text-[12px] tabular text-muted">{t.days} j {unit}</span></li>)}
    </ul>
  );
}

function toMarkdown(r: Report, c: ReportContent, agent: string) {
  const t = r.metrics.totals;
  const list = (title: string, xs: string[]) => (xs.length ? [`## ${title}`, "", ...xs.map((x) => `- ${x}`), ""] : []);
  return [
    `# ${c.title}`, "", `Rédigé par ${agent}, du ${r.metrics.period.from} au ${r.metrics.period.to}. État : ${STATUS[c.status].label}.`, "", c.executive_summary, "",
    ...(r.focus ? [`**Question :** ${r.focus}`, "", ...(c.focus_answer ? [c.focus_answer, ""] : [])] : []),
    ...list("Indicateurs", [`Terminées : ${t.completed_in_period}`, `Vélocité : ${num(t.velocity_per_week)} par semaine`, `En retard : ${t.overdue}`, `À l'heure : ${percent(t.on_time_rate)}`, `Durée médiane : ${days(t.cycle_median_days)}`]),
    ...list("Points marquants", c.highlights),
    ...list("Risques", c.risks.map((x) => `**${x.title}** (${LEVEL[x.severity].label}) : ${x.evidence} À faire : ${x.recommendation}`)),
    ...list("Recommandations", c.recommendations.map((x) => `${x.action}${x.owner ? ` (${x.owner})` : ""}, ${PRIORITY_LABEL[x.priority].toLowerCase()}`)),
    "## Équipe", "", c.team_analysis, "",
    ...list("Priorités de la période suivante", c.next_period_focus),
  ].join("\n");
}

function download(r: Report, c: ReportContent, agent: string) {
  const url = URL.createObjectURL(new Blob([toMarkdown(r, c, agent)], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `rapport-${r.metrics.period.to}.md`; a.click();
  URL.revokeObjectURL(url);
}
