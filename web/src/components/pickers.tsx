import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Check, Flag, Sparkles } from "lucide-react";
import { Avatar, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger, cn } from "./ui";
import { useUserMap } from "@/lib/hooks";
import { PRIORITIES, dueLabel, isoIn, priorityMeta, todayIso } from "@/lib/format";
import type { Priority, Section } from "@/lib/types";

export function AssigneePicker({ memberIds, value, onChange, children, align = "start" }: {
  memberIds: string[]; value: string | null; onChange: (id: string | null) => void; children: ReactNode; align?: "start" | "end";
}) {
  const users = useUserMap();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const members = useMemo(() => memberIds.map((id) => users.get(id)).filter(Boolean).filter((u) => u!.id !== "ai_cadence")
    .filter((u) => !q || u!.name.toLowerCase().includes(q.toLowerCase())), [memberIds, users, q]);
  const humans = members.filter((u) => !u!.is_ai);
  const ais = members.filter((u) => u!.is_ai);
  const pick = (id: string | null) => { onChange(id); setOpen(false); setQ(""); };
  const Row = ({ id }: { id: string | null }) => {
    const u = id ? users.get(id) : null;
    return (
      <button onClick={() => pick(id)} className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-hover">
        <Avatar user={u} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{u ? u.name : "Personne"}</span>
          {u?.is_ai && <span className="block truncate text-[11px] text-ai-fg">{u.ai_role?.split(":")[0]}</span>}
        </span>
        {value === id && <Check className="size-4 text-fg" />}
      </button>
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[280px]">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Assigner à…"
          className="mb-1 h-8 w-full rounded-md bg-transparent px-2 text-[13px] outline-none placeholder:text-faint" />
        <div className="max-h-[320px] overflow-y-auto border-t border-line pt-1">
          <Row id={null} />
          {humans.map((u) => <Row key={u!.id} id={u!.id} />)}
          {ais.length > 0 && <>
            <div className="mt-1 flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-ai-fg"><Sparkles className="size-3" />Coéquipiers IA</div>
            {ais.map((u) => <Row key={u!.id} id={u!.id} />)}
            <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-snug text-faint">Un coéquipier IA se met au travail dès qu'on lui assigne la tâche, et vous demande votre accord avant chaque modification.</p>
          </>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function PriorityPicker({ value, onChange, children }: { value: Priority; onChange: (p: Priority) => void; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent>
        {PRIORITIES.map((p) => (
          <MenuItem key={p.value} onSelect={() => onChange(p.value)} icon={<Flag className="size-3.5" style={{ color: p.color }} fill={p.value === "none" ? "none" : p.color} />}
            right={value === p.value ? <Check className="size-3.5" /> : undefined}>{p.label}</MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function PriorityFlag({ p, showLabel }: { p: Priority; showLabel?: boolean }) {
  if (p === "none" && !showLabel) return null;
  const m = priorityMeta(p);
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: p === "none" ? "var(--faint)" : m.color }} title={`Priorité ${m.label.toLowerCase()}`}>
      <Flag className="size-3.5" fill={p === "none" ? "none" : m.color} strokeWidth={2} />
      {showLabel && m.label}
    </span>
  );
}

export function DuePicker({ value, onChange, children }: { value: string | null; onChange: (d: string | null) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const set = (d: string | null) => { onChange(d); setOpen(false); };
  const quick: [string, string | null][] = [["Aujourd'hui", todayIso()], ["Demain", isoIn(1)], ["Dans 3 jours", isoIn(3)], ["Dans une semaine", isoIn(7)], ["Dans deux semaines", isoIn(14)], ["Aucune échéance", null]];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[240px] p-2">
        <input type="date" value={value ?? ""} onChange={(e) => set(e.target.value || null)}
          className="mb-1.5 h-9 w-full rounded-lg border border-line bg-panel px-2 text-[13px] outline-none focus:border-ai-line" />
        {quick.map(([label, d]) => (
          <button key={label} onClick={() => set(d)} className="flex h-8 w-full items-center justify-between rounded-md px-2 text-[13px] hover:bg-hover">
            <span>{label}</span>
            {d && <span className="text-[12px] text-faint">{dueLabel(d)?.label}</span>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function DueChip({ due, done, empty }: { due: string | null; done?: boolean; empty?: ReactNode }) {
  const d = dueLabel(due);
  if (!d) return <>{empty ?? null}</>;
  const tone = done ? "text-faint" : d.tone === "danger" ? "text-danger" : d.tone === "warning" ? "text-warning" : "text-muted";
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] tabular", tone)}><CalendarDays className="size-3.5" />{d.label}</span>;
}

export function SectionPicker({ sections, value, onChange, children }: { sections: Section[]; value: string | null; onChange: (id: string) => void; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent>
        {sections.map((s) => <MenuItem key={s.id} onSelect={() => onChange(s.id)} right={value === s.id ? <Check className="size-3.5" /> : undefined}>{s.name}</MenuItem>)}
      </MenuContent>
    </Menu>
  );
}
