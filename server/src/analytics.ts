import { badRequest, today, type Priority, type ProjectStatus, type Services } from "./services.js";

/**
 * Analyse des données du travail. Tous les chiffres sont calculés ici, de façon déterministe :
 * l'IA les commente mais ne les produit jamais. Les calculs portent sur les tâches de premier
 * niveau (comme le tableau de bord), sans plafond sur le nombre de tâches.
 */
export interface MetricTask {
  project_id: string; key: string; title: string; section_id: string | null; assignee_id: string | null; priority: Priority;
  due_on: string | null; completed: boolean; completed_at: string | null; created_at: string; last_activity_at: string;
}
export type FindingSeverity = "high" | "medium" | "low" | "positive";
export interface Finding { severity: FindingSeverity; code: string; message: string }
export interface WeekBucket { from: string; to: string; completed: number; created: number }
export interface WorkloadEntry { user_id: string | null; name: string; is_ai: boolean; open: number; overdue: number; high_priority_open: number; completed_in_period: number }
export interface TaskRef { key: string; title: string; assignee: string | null; priority: Priority; due_on: string | null; days: number }
export interface Totals {
  total: number; open: number; done: number; completion_rate: number; completed_in_period: number; created_in_period: number; previous_completed: number;
  velocity_per_week: number; overdue: number; avg_days_late: number | null; max_days_late: number | null; due_next_7_days: number; unassigned_open: number; no_due_open: number;
  stale: number; on_time_rate: number | null; on_time_sample: number; cycle_median_days: number | null; cycle_p85_days: number | null; cycle_sample: number;
}
interface Core { period: { from: string; to: string; days: number }; totals: Totals; weekly: WeekBucket[]; workload: WorkloadEntry[]; overdue_tasks: TaskRef[]; stale_tasks: TaskRef[] }
export interface SectionHealth { section: string; open: number; overdue: number; avg_age_days: number | null }
export interface Forecast { remaining: number; projected_end: string | null; due_on: string | null; margin_days: number | null; confidence: "low" | "medium" | "high" }
export interface ProjectMetrics extends Core {
  scope: "project"; project: { id: string; key: string; name: string; status: ProjectStatus; due_on: string | null };
  sections: SectionHealth[]; forecast: Forecast; findings: Finding[];
}
export interface PortfolioProject {
  project_id: string; key: string; name: string; status: ProjectStatus; due_on: string | null; open: number; done: number; overdue: number;
  completed_in_period: number; velocity_per_week: number; margin_days: number | null; health: "good" | "watch" | "critical";
}
export interface PortfolioMetrics extends Core { scope: "portfolio"; projects: PortfolioProject[]; findings: Finding[]; excluded_projects: number }
export type Metrics = ProjectMetrics | PortfolioMetrics;
export type UserLookup = Map<string, { name: string; is_ai: boolean }>;

export const STALE_DAYS = 14;
const DAY_MS = 86_400_000;
const LIST_LIMIT = 8;
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export const clampPeriod = (v: unknown) => Math.min(365, Math.max(7, Math.round(Number(v)) || 30));
const day = (iso: string) => iso.slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(day(to)) - Date.parse(day(from))) / DAY_MS);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10);
const round = (n: number, digits = 1) => { const f = 10 ** digits; return Math.round(n * f) / f; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const within = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;
const isHigh = (p: Priority) => p === "urgent" || p === "high";
export const frNumber = (n: number) => String(n).replace(".", ",");
const frDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function core(tasks: MetricTask[], users: UserLookup, now: string, periodDays: number): Core {
  const from = addDays(now, -(periodDays - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(periodDays - 1));
  const staleLimit = addDays(now, -STALE_DAYS);
  const open = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);
  const completedIn = (a: string, b: string) => done.filter((t) => within(t.completed_at && day(t.completed_at), a, b));
  const completed = completedIn(from, now);
  const late = open.filter((t) => t.due_on && t.due_on < now);
  const stale = open.filter((t) => day(t.last_activity_at) < staleLimit);
  const lateDays = late.map((t) => daysBetween(t.due_on!, now));
  // Une tâche complétée avant sa création (données importées) ne dit rien de la durée de traitement
  const cycle = completed.map((t) => (Date.parse(t.completed_at!) - Date.parse(t.created_at)) / DAY_MS).filter((d) => d >= 0);
  const dated = completed.filter((t) => t.due_on);
  const median = quantile(cycle, 0.5), p85 = quantile(cycle, 0.85);

  const ref = (t: MetricTask, days: number): TaskRef => ({ key: t.key, title: t.title, assignee: t.assignee_id ? users.get(t.assignee_id)?.name ?? null : null, priority: t.priority, due_on: t.due_on, days });
  const weeks = Math.max(2, Math.min(12, Math.ceil(periodDays / 7)));
  const weekly: WeekBucket[] = [...Array(weeks)].map((_, i) => {
    const to = addDays(now, -7 * (weeks - 1 - i));
    const start = addDays(to, -6);
    return { from: start, to, completed: completedIn(start, to).length, created: tasks.filter((t) => within(day(t.created_at), start, to)).length };
  });

  const byUser = new Map<string, WorkloadEntry>();
  const entry = (id: string | null) => {
    const k = id ?? "";
    let e = byUser.get(k);
    if (!e) { const u = id ? users.get(id) : null; e = { user_id: id, name: id ? u?.name ?? "Inconnu" : "Sans responsable", is_ai: !!u?.is_ai, open: 0, overdue: 0, high_priority_open: 0, completed_in_period: 0 }; byUser.set(k, e); }
    return e;
  };
  for (const t of open) { const e = entry(t.assignee_id); e.open++; if (t.due_on && t.due_on < now) e.overdue++; if (isHigh(t.priority)) e.high_priority_open++; }
  for (const t of completed) entry(t.assignee_id).completed_in_period++;

  return {
    period: { from, to: now, days: periodDays },
    totals: {
      total: tasks.length, open: open.length, done: done.length, completion_rate: tasks.length ? round(done.length / tasks.length, 3) : 0,
      completed_in_period: completed.length, created_in_period: tasks.filter((t) => within(day(t.created_at), from, now)).length, previous_completed: completedIn(prevFrom, prevTo).length,
      velocity_per_week: round(completed.length / (periodDays / 7)), overdue: late.length, avg_days_late: lateDays.length ? round(mean(lateDays)!) : null, max_days_late: lateDays.length ? Math.max(...lateDays) : null,
      due_next_7_days: open.filter((t) => within(t.due_on, now, addDays(now, 7))).length, unassigned_open: open.filter((t) => !t.assignee_id).length, no_due_open: open.filter((t) => !t.due_on).length,
      stale: stale.length, on_time_rate: dated.length ? round(dated.filter((t) => day(t.completed_at!) <= t.due_on!).length / dated.length, 3) : null, on_time_sample: dated.length,
      cycle_median_days: median === null ? null : round(median), cycle_p85_days: p85 === null ? null : round(p85), cycle_sample: cycle.length,
    },
    weekly,
    workload: [...byUser.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, "fr")),
    overdue_tasks: late.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.due_on!.localeCompare(b.due_on!)).slice(0, LIST_LIMIT).map((t) => ref(t, daysBetween(t.due_on!, now))),
    stale_tasks: stale.sort((a, b) => a.last_activity_at.localeCompare(b.last_activity_at)).slice(0, LIST_LIMIT).map((t) => ref(t, daysBetween(t.last_activity_at, now))),
  };
}

function coreFindings(c: Core, tasks: MetricTask[]): Finding[] {
  const t = c.totals; const out: Finding[] = [];
  const now = c.period.to;
  if (t.overdue) {
    const critical = tasks.filter((x) => !x.completed && x.due_on && x.due_on < now && isHigh(x.priority)).length;
    out.push({ severity: critical || t.overdue / t.open >= 0.25 ? "high" : "medium", code: "overdue", message: `${plural(t.overdue, "tâche")} en retard, dont ${critical} de priorité haute ou urgente (retard moyen ${frNumber(t.avg_days_late!)} j, maximum ${t.max_days_late} j).` });
  }
  if (t.open && !t.completed_in_period) out.push({ severity: "high", code: "no_throughput", message: `Aucune tâche terminée sur les ${c.period.days} derniers jours, alors que ${plural(t.open, "tâche")} restent ouvertes.` });
  if (t.created_in_period - t.completed_in_period >= 3) out.push({ severity: "medium", code: "scope_growth", message: `Le reste à faire augmente : ${t.created_in_period} tâches créées pour ${t.completed_in_period} terminées sur la période.` });
  else if (t.completed_in_period > t.created_in_period) out.push({ severity: "positive", code: "scope_shrinking", message: `Le reste à faire diminue : ${t.completed_in_period} tâches terminées pour ${t.created_in_period} créées sur la période.` });
  if (t.on_time_sample >= 3 && t.on_time_rate !== null) {
    if (t.on_time_rate >= 0.8) out.push({ severity: "positive", code: "on_time", message: `${Math.round(t.on_time_rate * 100)} % des tâches datées ont été livrées à l'heure.` });
    else if (t.on_time_rate < 0.5) out.push({ severity: "medium", code: "late_delivery", message: `Seulement ${Math.round(t.on_time_rate * 100)} % des tâches datées ont été livrées à l'heure.` });
  }
  const people = c.workload.filter((w) => w.user_id && w.open > 0);
  const avg = mean(people.map((w) => w.open));
  if (people.length >= 2 && avg) for (const w of people) if (w.open >= 5 && w.open > avg * 1.5) out.push({ severity: "medium", code: "overload", message: `${w.name} concentre ${w.open} tâches ouvertes, pour une moyenne de ${frNumber(round(avg))} par personne.` });
  if (t.stale) out.push({ severity: t.stale >= 3 ? "medium" : "low", code: "stale", message: `${plural(t.stale, "tâche")} ouverte${t.stale > 1 ? "s" : ""} sans activité depuis plus de ${STALE_DAYS} jours.` });
  if (t.unassigned_open) out.push({ severity: "low", code: "unassigned", message: `${plural(t.unassigned_open, "tâche")} ouverte${t.unassigned_open > 1 ? "s" : ""} sans responsable.` });
  if (t.open >= 5 && t.no_due_open / t.open >= 0.3) out.push({ severity: "low", code: "no_due", message: `${t.no_due_open} tâches ouvertes sur ${t.open} n'ont pas d'échéance : les prévisions en sont moins fiables.` });
  return out;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, positive: 3 };
const bySeverity = (a: Finding, b: Finding) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];

/** Calcul pur des indicateurs d'un projet. */
export function computeProjectMetrics(i: { project: ProjectMetrics["project"]; tasks: MetricTask[]; sections: { id: string; name: string }[]; users: UserLookup; now: string; periodDays: number }): ProjectMetrics {
  const c = core(i.tasks, i.users, i.now, i.periodDays);
  const open = i.tasks.filter((t) => !t.completed);
  const sections: SectionHealth[] = i.sections.map((s) => {
    const list = open.filter((t) => t.section_id === s.id);
    const ages = list.map((t) => daysBetween(t.created_at, i.now));
    return { section: s.name, open: list.length, overdue: list.filter((t) => t.due_on && t.due_on < i.now).length, avg_age_days: ages.length ? round(mean(ages)!) : null };
  });
  const { velocity_per_week: velocity, open: remaining, completed_in_period: sample } = c.totals;
  const projected = remaining === 0 ? i.now : velocity > 0 ? addDays(i.now, Math.ceil((remaining / velocity) * 7)) : null;
  const forecast: Forecast = {
    remaining, projected_end: projected, due_on: i.project.due_on, margin_days: projected && i.project.due_on ? daysBetween(projected, i.project.due_on) : null,
    confidence: sample >= 20 ? "high" : sample >= 8 ? "medium" : "low",
  };
  const findings = coreFindings(c, i.tasks);
  if (forecast.margin_days !== null && remaining) {
    const reliable = forecast.confidence !== "low";
    if (forecast.margin_days < 0) findings.push({ severity: reliable ? "high" : "medium", code: "forecast_late", message: `${reliable ? "" : "Estimation peu fiable, trop peu de tâches terminées. "}Au rythme actuel (${frNumber(velocity)} tâche(s) par semaine), la fin est estimée au ${frDate(forecast.projected_end!)}, soit ${-forecast.margin_days} j après l'échéance du ${frDate(forecast.due_on!)}.` });
    else findings.push({ severity: "positive", code: "forecast_ok", message: `Au rythme actuel (${frNumber(velocity)} tâche(s) par semaine), la fin est estimée au ${frDate(forecast.projected_end!)}, avec ${forecast.margin_days} j de marge.` });
  }
  const avgAge = mean(open.map((t) => daysBetween(t.created_at, i.now)));
  const worst = sections.filter((s) => s.open >= 3 && s.avg_age_days !== null).sort((a, b) => b.avg_age_days! - a.avg_age_days!)[0];
  if (worst && avgAge && worst.avg_age_days! > avgAge * 1.25) findings.push({ severity: "medium", code: "bottleneck", message: `Goulot possible en « ${worst.section} » : ${worst.open} tâches ouvertes, âgées de ${frNumber(worst.avg_age_days!)} j en moyenne.` });
  return { scope: "project", project: i.project, ...c, sections, forecast, findings: findings.sort(bySeverity) };
}

const HEALTH_RANK: Record<PortfolioProject["health"], number> = { critical: 0, watch: 1, good: 2 };
function projectHealth(m: ProjectMetrics): PortfolioProject["health"] {
  const reliablyLate = m.forecast.confidence !== "low" && (m.forecast.margin_days ?? 0) < 0;
  if (m.findings.some((f) => f.severity === "high")) return m.totals.overdue >= 3 || reliablyLate ? "critical" : "watch";
  return m.findings.some((f) => f.severity === "medium") ? "watch" : "good";
}

/** Calcul pur des indicateurs d'un portefeuille de projets. */
export function computePortfolioMetrics(i: { projects: ProjectMetrics["project"][]; tasks: MetricTask[]; sections: { id: string; name: string; project_id: string }[]; users: UserLookup; now: string; periodDays: number; excluded: number }): PortfolioMetrics {
  const c = core(i.tasks, i.users, i.now, i.periodDays);
  const details = i.projects.map((project) => computeProjectMetrics({ project, tasks: i.tasks.filter((t) => t.project_id === project.id), sections: i.sections.filter((s) => s.project_id === project.id), users: i.users, now: i.now, periodDays: i.periodDays }));
  const projects = details.map((m): PortfolioProject => ({
    project_id: m.project.id, key: m.project.key, name: m.project.name, status: m.project.status, due_on: m.project.due_on, open: m.totals.open, done: m.totals.done, overdue: m.totals.overdue,
    completed_in_period: m.totals.completed_in_period, velocity_per_week: m.totals.velocity_per_week, margin_days: m.forecast.margin_days, health: projectHealth(m),
  })).sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || b.overdue - a.overdue);
  const findings = [...coreFindings(c, i.tasks), ...details.flatMap((m) => m.findings.filter((f) => ["forecast_late", "bottleneck"].includes(f.code)).map((f) => ({ ...f, message: `${m.project.key} : ${f.message}` })))].sort(bySeverity).slice(0, 12);
  return { scope: "portfolio", ...c, projects, findings, excluded_projects: i.excluded };
}

export class Analytics {
  constructor(private svc: Services) {}

  private async users(orgId: string): Promise<UserLookup> {
    return new Map((await this.svc.usersOf(orgId)).map((u) => [u.id, { name: u.name, is_ai: u.is_ai }]));
  }
  private tasksOf(projectIds: string[]) {
    return this.svc.db.query<MetricTask>(`SELECT t.project_id, p.key || '-' || t.number AS key, t.title, t.section_id, t.assignee_id, t.priority, t.due_on, t.completed, t.completed_at, t.created_at,
        GREATEST(t.updated_at, (SELECT max(c.created_at) FROM comments c WHERE c.task_id = t.id)) AS last_activity_at
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ANY($1) AND t.parent_id IS NULL`, [projectIds]);
  }

  /** Indicateurs d'un projet, avec les droits de `actorId`. */
  async project(actorId: string, projectId: string, periodDays: number): Promise<ProjectMetrics> {
    const p = await this.svc.getProject(actorId, projectId);
    return computeProjectMetrics({
      project: { id: p.id, key: p.key, name: p.name, status: p.status, due_on: p.due_on }, tasks: await this.tasksOf([p.id]),
      sections: p.sections, users: await this.users(p.org_id), now: today(), periodDays: clampPeriod(periodDays),
    });
  }

  /** Indicateurs des projets que `actorId` peut lire, limités à `allowedIds` si fourni. */
  async portfolio(actorId: string, orgId: string, periodDays: number, allowedIds?: Set<string>): Promise<PortfolioMetrics> {
    const all = await this.svc.listProjects(actorId, orgId);
    const list = allowedIds ? all.filter((p) => allowedIds.has(p.id)) : all;
    if (!list.length) throw badRequest("Aucun projet accessible à analyser");
    const ids = list.map((p) => p.id);
    return computePortfolioMetrics({
      projects: list.map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status, due_on: p.due_on })), tasks: await this.tasksOf(ids),
      sections: await this.svc.db.query<{ id: string; name: string; project_id: string }>("SELECT id, name, project_id FROM sections WHERE project_id = ANY($1) ORDER BY position", [ids]),
      users: await this.users(orgId), now: today(), periodDays: clampPeriod(periodDays), excluded: allowedIds ? allowedIds.size - list.length : 0,
    });
  }
}
