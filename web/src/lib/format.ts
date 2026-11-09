import { differenceInCalendarDays, format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import type { Priority, ProjectStatus } from "./types";

export const todayIso = () => format(new Date(), "yyyy-MM-dd");
export const isoIn = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return format(d, "yyyy-MM-dd");
};
const asDate = (iso: string) => (iso.length === 10 ? parseISO(iso + "T12:00:00") : parseISO(iso));

export function dueLabel(
  iso: string | null,
): { label: string; tone: "danger" | "warning" | "muted" | "success" } | null {
  if (!iso) return null;
  const diff = differenceInCalendarDays(asDate(iso), new Date());
  if (diff < 0) return { label: diff === -1 ? "Hier" : format(asDate(iso), "d MMM", { locale: fr }), tone: "danger" };
  if (diff === 0) return { label: "Aujourd'hui", tone: "warning" };
  if (diff === 1) return { label: "Demain", tone: "warning" };
  if (diff < 7)
    return { label: format(asDate(iso), "EEEE", { locale: fr }).replace(/^./, (c) => c.toUpperCase()), tone: "muted" };
  return { label: format(asDate(iso), "d MMM", { locale: fr }), tone: "muted" };
}
export const longDate = (iso: string) => format(asDate(iso), "EEEE d MMMM yyyy", { locale: fr });
export const shortDate = (iso: string) => format(asDate(iso), "d MMM", { locale: fr });
export const ago = (iso: string) => {
  const diff = Date.now() - Date.parse(iso);
  if (diff < 45_000) return "à l'instant";
  return "il y a " + formatDistanceToNowStrict(parseISO(iso), { locale: fr });
};
export const isOverdue = (iso: string | null, done: boolean) => !!iso && !done && iso < todayIso();

export const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: "urgent", label: "Urgente", color: "var(--danger)" },
  { value: "high", label: "Haute", color: "var(--warning)" },
  { value: "medium", label: "Moyenne", color: "var(--info)" },
  { value: "low", label: "Basse", color: "var(--faint)" },
  { value: "none", label: "Aucune", color: "var(--faint)" },
];
export const priorityMeta = (p: Priority) => PRIORITIES.find((x) => x.value === p)!;

export const STATUS: Record<ProjectStatus, { label: string; color: string; soft: string }> = {
  on_track: { label: "Dans les temps", color: "var(--success)", soft: "var(--success-soft)" },
  at_risk: { label: "À risque", color: "var(--warning)", soft: "var(--warning-soft)" },
  off_track: { label: "En retard", color: "var(--danger)", soft: "var(--danger-soft)" },
  done: { label: "Terminé", color: "var(--info)", soft: "var(--info-soft)" },
};

export const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Bonsoir" : h < 18 ? "Bonjour" : "Bonsoir";
};
export const firstName = (n: string) => n.split(" ")[0];
