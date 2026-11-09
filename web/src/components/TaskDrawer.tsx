import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUpRight, CalendarDays, ChevronRight, Copy, CornerDownLeft, Ellipsis, Flag, Hash, LayoutGrid, ListChecks, Plus, Send, Sparkles,
  Tag, Trash2, User as UserIcon, Wand2, X, History, MessageSquare, CalendarClock, CopyPlus, FolderInput, Pencil,
} from "lucide-react";
import { Avatar, Button, Checkbox, Chip, IconButton, Markdown, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger, ProjectIcon, Spinner, cn } from "./ui";
import { AssigneePicker, DueChip, DuePicker, PriorityFlag, PriorityPicker, SectionPicker } from "./pickers";
import { AiBadge, RUN_STATUS, RunTimeline, isActive } from "./ai";
import { useAgents, useCreateTask, useDeleteTask, useMe, useProject, useProjects, useRuns, useTask, useUpdateTask, useUserMap } from "@/lib/hooks";
import { ago, dueLabel, shortDate } from "@/lib/format";
import { api } from "@/lib/api";
import type { Task, TaskDetail } from "@/lib/types";

export function TaskDrawer({ taskId, onClose, onOpenTask }: { taskId: string | null; onClose: () => void; onOpenTask: (id: string) => void }) {
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[data-radix-popper-content-wrapper]")) return;
      const el = document.activeElement as HTMLElement | null;
      // Premier Échap : on quitte le champ en cours de saisie sans perdre le brouillon
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) { el.blur(); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);
  return (
    <AnimatePresence>
      {taskId && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-30 bg-black/10 lg:bg-transparent dark:bg-black/40 lg:dark:bg-transparent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside key="drawer" role="dialog" aria-label="Détail de la tâche"
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 420, damping: 38 }}
            className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-panel shadow-lg sm:w-[min(640px,92vw)] sm:rounded-l-2xl">
            <DrawerBody key={taskId} taskId={taskId} onClose={onClose} onOpenTask={onOpenTask} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function DrawerBody({ taskId, onClose, onOpenTask }: { taskId: string; onClose: () => void; onOpenTask: (id: string) => void }) {
  const { data: t, isLoading, error } = useTask(taskId);
  const { data: project } = useProject(t?.project_id);
  const update = useUpdateTask();
  const del = useDeleteTask();
  const users = useUserMap();
  const { data: projects } = useProjects();
  const qc = useQueryClient();
  const canEdit = t?.role === "editor" || t?.role === "admin";
  const save = (patch: Partial<Task>) => t && update.mutate({ id: t.id, ...patch });

  if (isLoading) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  if (error || !t) return <div className="p-6 text-[13px] text-danger">{(error as Error)?.message ?? "Tâche introuvable"}</div>;
  const assignee = t.assignee_id ? users.get(t.assignee_id) : null;
  const memberIds = project?.members.map((m) => m.user_id) ?? [];

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <ProjectIcon icon={t.project.icon} color={t.project.color} size={20} />
        <span className="truncate text-[13px] text-muted">{t.project.name}</span>
        {t.section && <><ChevronRight className="size-3.5 text-faint" /><span className="truncate text-[13px] text-muted">{t.section.name}</span></>}
        <span className="ml-1 font-mono text-[12px] text-faint">{t.key}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Copier le lien" onClick={() => { navigator.clipboard?.writeText(`${location.origin}/projects/${t.project_id}?task=${t.id}`).then(() => toast.success("Lien copié"), () => {}); }}><Copy className="size-4" /></IconButton>
          {canEdit && (
            <Menu>
              <MenuTrigger asChild><IconButton label="Plus d'actions"><Ellipsis className="size-4" /></IconButton></MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={<CopyPlus className="size-3.5" />} onSelect={async () => {
                  try { const c = await api.post<Task>(`/api/tasks/${t.id}/duplicate`, { subtasks: true }); qc.invalidateQueries({ queryKey: ["tasks"] }); toast.success("Tâche dupliquée"); onOpenTask(c.id); }
                  catch (e) { toast.error((e as Error).message); }
                }}>Dupliquer avec les sous-tâches</MenuItem>
                {!t.parent_id && (
                  <MenuSub label="Déplacer vers un projet" icon={<FolderInput className="size-3.5" />}>
                    {(projects ?? []).filter((p) => p.id !== t.project_id && (p.role === "editor" || p.role === "admin")).map((p) => (
                      <MenuItem key={p.id} icon={<ProjectIcon icon={p.icon} color={p.color} size={16} />} onSelect={async () => {
                        try {
                          const moved = await api.post<Task>(`/api/tasks/${t.id}/move-project`, { project_id: p.id });
                          qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["task", t.id] }); qc.invalidateQueries({ queryKey: ["projects"] });
                          toast.success(`Déplacée vers « ${p.name} »${t.assignee_id && !moved.assignee_id ? " · responsable retiré (pas membre)" : ""}`);
                        } catch (e) { toast.error((e as Error).message); }
                      }}>{p.name}</MenuItem>
                    ))}
                  </MenuSub>
                )}
                <MenuSeparator />
                <MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={() => del.mutate(t.id, { onSuccess: () => { toast.success("Tâche supprimée"); onClose(); } })}>Supprimer la tâche</MenuItem>
              </MenuContent>
            </Menu>
          )}
          <IconButton label="Fermer" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-10 pt-5 sm:px-6">
          {t.parent && (
            <button onClick={() => onOpenTask(t.parent!.id)} className="mb-2 flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
              <CornerDownLeft className="size-3.5 rotate-90" />Sous-tâche de <span className="font-mono text-faint">{t.parent.key}</span> {t.parent.title}
            </button>
          )}
          <div className="flex items-start gap-3">
            <div className="pt-[7px]"><Checkbox checked={t.completed} size={22} onChange={(v) => canEdit && save({ completed: v })} /></div>
            <TitleEditor value={t.title} disabled={!canEdit} onSave={(title) => save({ title })} done={t.completed} />
          </div>

          {/* Champs */}
          <dl className="mt-5 grid grid-cols-[112px_1fr] items-center gap-x-3 gap-y-1 text-[13px]">
            <Field icon={<UserIcon className="size-3.5" />} label="Responsable">
              <AssigneePicker memberIds={memberIds} value={t.assignee_id} onChange={(id) => save({ assignee_id: id })}>
                <button disabled={!canEdit} className="flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-hover disabled:hover:bg-transparent">
                  <Avatar user={assignee} size={22} /><span className={assignee ? "" : "text-faint"}>{assignee?.name ?? "Personne"}</span>
                  {assignee?.is_ai && <AiBadge label="Coéquipier IA" />}
                </button>
              </AssigneePicker>
            </Field>
            <Field icon={<CalendarClock className="size-3.5" />} label="Début">
              <DuePicker value={t.start_on} onChange={(d) => save({ start_on: d })}>
                <button disabled={!canEdit} className="flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-hover">
                  {t.start_on ? <span className="tabular">{shortDate(t.start_on)}</span> : <span className="text-faint">Aucune</span>}
                </button>
              </DuePicker>
            </Field>
            <Field icon={<CalendarDays className="size-3.5" />} label="Échéance">
              <DuePicker value={t.due_on} onChange={(d) => save({ due_on: d })}>
                <button disabled={!canEdit} className="flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-hover">
                  <DueChip due={t.due_on} done={t.completed} empty={<span className="text-faint">Aucune</span>} />
                  {t.due_on && dueLabel(t.due_on)?.label !== shortDate(t.due_on) && <span className="text-[12px] text-faint">{shortDate(t.due_on)}</span>}
                </button>
              </DuePicker>
            </Field>
            <Field icon={<Flag className="size-3.5" />} label="Priorité">
              <PriorityPicker value={t.priority} onChange={(p) => save({ priority: p })}>
                <button disabled={!canEdit} className="flex h-8 items-center rounded-md px-1.5 hover:bg-hover"><PriorityFlag p={t.priority} showLabel /></button>
              </PriorityPicker>
            </Field>
            {!t.parent_id && project && (
              <Field icon={<LayoutGrid className="size-3.5" />} label="Section">
                <SectionPicker sections={project.sections} value={t.section_id} onChange={(id) => save({ section_id: id })}>
                  <button disabled={!canEdit} className="flex h-8 items-center rounded-md px-1.5 hover:bg-hover">{t.section?.name ?? "—"}</button>
                </SectionPicker>
              </Field>
            )}
            <Field icon={<Tag className="size-3.5" />} label="Étiquettes">
              <TagEditor tags={t.tags} disabled={!canEdit} onChange={(tags) => save({ tags })} />
            </Field>
          </dl>

          <AiPanel t={t} canEdit={canEdit} memberIds={memberIds} />

          {/* Description */}
          <section className="mt-7">
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">Description</h3>
              {canEdit && <ImproveDescription t={t} />}
            </div>
            <DescriptionEditor value={t.description} disabled={!canEdit} onSave={(description) => save({ description })} />
          </section>

          <Subtasks t={t} canEdit={canEdit} memberIds={memberIds} onOpenTask={onOpenTask} />
          <Conversation t={t} canComment={t.role !== "viewer"} memberIds={memberIds} />
        </div>
      </div>
    </>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (<>
    <dt className="flex items-center gap-2 text-muted">{icon}{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>);
}

function TitleEditor({ value, onSave, disabled, done }: { value: string; onSave: (v: string) => void; disabled?: boolean; done: boolean }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = el.scrollHeight + "px"; } }, [v]);
  return (
    <textarea ref={ref} value={v} disabled={disabled} rows={1} onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className={cn("w-full resize-none bg-transparent text-[22px] font-semibold leading-tight tracking-[-0.02em] outline-none", done && "text-muted line-through decoration-1")} />
  );
}

function DescriptionEditor({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = Math.max(96, el.scrollHeight) + "px"; } }, [v, editing]);
  if (!editing) {
    return (
      <button disabled={disabled} onClick={() => setEditing(true)} className="block w-full rounded-lg px-2.5 py-2 text-left text-[13.5px] leading-relaxed hover:bg-hover disabled:hover:bg-transparent">
        {value ? <Markdown text={value} /> : <span className="text-faint">Ajoutez du contexte, des liens, des critères de réussite…</span>}
      </button>
    );
  }
  return (
    <textarea ref={ref} autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { setEditing(false); if (v !== value) onSave(v); }}
      className="w-full resize-none rounded-lg border border-line-strong bg-panel px-2.5 py-2 text-[13.5px] leading-relaxed outline-none focus:border-ai-line" />
  );
}

function TagEditor({ tags, onChange, disabled }: { tags: string[]; onChange: (t: string[]) => void; disabled?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState("");
  const add = () => { const x = v.trim().toLowerCase(); if (x && !tags.includes(x)) onChange([...tags, x]); setV(""); setAdding(false); };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 px-1.5">
      {tags.map((tg) => (
        <span key={tg} className="group inline-flex h-[22px] items-center gap-1 rounded-md bg-hover px-1.5 text-[12px] text-muted">
          {tg}{!disabled && <button aria-label={`Retirer ${tg}`} onClick={() => onChange(tags.filter((x) => x !== tg))} className="opacity-0 group-hover:opacity-100"><X className="size-3" /></button>}
        </span>
      ))}
      {!disabled && (adding
        ? <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={add} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }} className="h-[22px] w-24 rounded-md border border-line bg-transparent px-1.5 text-[12px] outline-none" />
        : <button onClick={() => setAdding(true)} className="inline-flex h-[22px] items-center gap-0.5 rounded-md px-1 text-[12px] text-faint hover:bg-hover hover:text-fg"><Plus className="size-3" />{tags.length ? "" : "Ajouter"}</button>)}
    </div>
  );
}

// ------------------------------------------------------------------ IA sur la tâche
function AiPanel({ t, canEdit, memberIds }: { t: TaskDetail; canEdit: boolean; memberIds: string[] }) {
  const { data: runs } = useRuns({ taskId: t.id });
  const { data: agents } = useAgents();
  const users = useUserMap();
  const [busy, setBusy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const qc = useQueryClient();
  const latest = runs?.[0];
  const memberAgents = (agents ?? []).filter((a) => memberIds.includes(a.id));
  const delegate = async (agentId: string) => {
    setBusy(agentId);
    try { await api.post(`/api/tasks/${t.id}/ai/run`, { agent_id: agentId }); qc.invalidateQueries({ queryKey: ["runs"] }); toast.success(`${users.get(agentId)?.name} s'en occupe`); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const active = latest && isActive(latest.status);
  return (
    <section className={cn("mt-6 rounded-2xl border p-4", active ? "ai-ring border-transparent bg-ai-soft/40" : "border-line bg-bg/50")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-lg bg-ai-soft text-ai-fg"><Sparkles className="size-3.5" /></span>
        <h3 className="text-[13px] font-semibold">Coéquipiers IA</h3>
        {runs && runs.length > 1 && <button onClick={() => setShowHistory((v) => !v)} className="ml-auto flex items-center gap-1 text-[12px] text-muted hover:text-fg"><History className="size-3.5" />{runs.length} interventions</button>}
      </div>
      {latest ? (
        <div className="mt-3"><RunTimeline runId={latest.id} /></div>
      ) : (
        <p className="mt-2 text-[13px] text-muted">Confiez cette tâche à un coéquipier IA : il lit le contexte du projet, agit avec ses propres droits et vous demande votre accord avant chaque modification.</p>
      )}
      {canEdit && !active && memberAgents.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {memberAgents.map((a) => (
            <Button key={a.id} size="sm" variant="ai" loading={busy === a.id} icon={<Avatar user={a} size={16} />} onClick={() => delegate(a.id)}>
              {latest ? `Relancer ${a.name}` : `Confier à ${a.name}`}
            </Button>
          ))}
        </div>
      )}
      {canEdit && memberAgents.length === 0 && <p className="mt-2 text-[12px] text-faint">Aucun coéquipier IA n'est membre de ce projet.</p>}
      <AnimatePresence>
        {showHistory && runs && (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-3 space-y-1 overflow-hidden border-t border-line pt-3">
            {runs.slice(1).map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-[12.5px]">
                <Avatar user={users.get(r.agent_id)} size={16} /><span>{users.get(r.agent_id)?.name}</span>
                <span className={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</span>
                <span className="text-faint">· {r.kind === "mention" ? "mention" : r.kind === "rule" ? "règle" : "assignation"}</span>
                <span className="ml-auto text-faint">{ago(r.created_at)}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
  );
}

function ImproveDescription({ t }: { t: TaskDetail }) {
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const update = useUpdateTask();
  return (
    <>
      <Button size="sm" variant="ghost" loading={loading} icon={<Wand2 className="size-3.5 text-ai-fg" />}
        onClick={async () => { setLoading(true); try { setProposal((await api.post<{ description: string }>(`/api/tasks/${t.id}/ai/description`)).description); } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); } }}>
        Améliorer
      </Button>
      {proposal && (
        <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-[600px] rounded-2xl border border-ai-line bg-raised p-4 shadow-lg sm:absolute sm:inset-x-6 sm:bottom-6">
          <div className="mb-2 flex items-center gap-2"><AiBadge label="Proposition" /><span className="text-[12.5px] text-muted">Nouvelle description</span></div>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg bg-hover px-3 py-2 text-[13px]"><Markdown text={proposal} /></div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" onClick={() => setProposal(null)}>Ignorer</Button>
            <Button size="sm" variant="primary" onClick={() => { update.mutate({ id: t.id, description: proposal }); setProposal(null); toast.success("Description mise à jour"); }}>Remplacer</Button>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ sous-tâches
function Subtasks({ t, canEdit, memberIds, onOpenTask }: { t: TaskDetail; canEdit: boolean; memberIds: string[]; onOpenTask: (id: string) => void }) {
  const create = useCreateTask();
  const qc = useQueryClient();
  const update = useUpdateTask();
  const users = useUserMap();
  const [v, setV] = useState("");
  const [suggest, setSuggest] = useState<{ title: string; due_on: string | null; on: boolean }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const done = t.subtasks.filter((s) => s.completed).length;
  const add = () => { if (!v.trim()) return; create.mutate({ project_id: t.project_id, parent_id: t.id, title: v.trim() }); setV(""); };
  const askAi = async () => {
    setLoading(true);
    try { const r = await api.post<{ subtasks: { title: string; due_on: string | null }[] }>(`/api/tasks/${t.id}/ai/subtasks`); setSuggest(r.subtasks.map((s) => ({ ...s, on: true }))); }
    catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  };
  const accept = async () => {
    const chosen = suggest!.filter((s) => s.on);
    await api.post(`/api/projects/${t.project_id}/tasks/bulk`, { tasks: chosen.map((s) => ({ title: s.title, due_on: s.due_on, parent_id: t.id })) }).catch((e) => toast.error(e.message));
    setSuggest(null); toast.success(`${chosen.length} sous-tâche(s) ajoutée(s)`);
    qc.invalidateQueries({ queryKey: ["task", t.id] }); qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  return (
    <section className="mt-7">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Sous-tâches</h3>
        {t.subtasks.length > 0 && <span className="text-[12px] tabular text-faint">{done}/{t.subtasks.length}</span>}
        {canEdit && !suggest && <Button size="sm" variant="ghost" className="ml-auto" loading={loading} icon={<Sparkles className="size-3.5 text-ai-fg" />} onClick={askAi}>Suggérer</Button>}
      </div>
      {t.subtasks.length > 0 && (
        <div className="mb-1 h-1 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-success transition-all" style={{ width: `${(done / t.subtasks.length) * 100}%` }} /></div>
      )}
      <ul className="divide-y divide-line">
        {t.subtasks.map((s) => (
          <li key={s.id} className="group flex h-10 items-center gap-2.5 px-1">
            <Checkbox checked={s.completed} size={16} onChange={(c) => canEdit && update.mutate({ id: s.id, completed: c })} />
            <button onClick={() => onOpenTask(s.id)} className={cn("min-w-0 flex-1 truncate text-left text-[13.5px] hover:underline", s.completed && "text-faint line-through")}>{s.title}</button>
            <DueChip due={s.due_on} done={s.completed} />
            <AssigneePicker memberIds={memberIds} value={s.assignee_id} onChange={(id) => update.mutate({ id: s.id, assignee_id: id })} align="end">
              <button disabled={!canEdit} className="rounded-full"><Avatar user={s.assignee_id ? users.get(s.assignee_id) : null} size={20} /></button>
            </AssigneePicker>
            <ArrowUpRight className="size-3.5 text-faint opacity-0 group-hover:opacity-100" />
          </li>
        ))}
      </ul>
      {suggest && (
        <div className="mt-2 rounded-xl border border-ai-line bg-ai-soft/40 p-3">
          <div className="mb-2 flex items-center gap-2"><AiBadge label="Suggestions" /><span className="text-[12.5px] text-muted">Décochez ce qui ne convient pas</span></div>
          {suggest.map((s, i) => (
            <label key={i} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1.5 hover:bg-hover">
              <input type="checkbox" checked={s.on} onChange={() => setSuggest(suggest.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} className="size-4 accent-[var(--ai)]" />
              <span className="flex-1 text-[13.5px]">{s.title}</span>
              {s.due_on && <DueChip due={s.due_on} />}
            </label>
          ))}
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" onClick={() => setSuggest(null)}>Annuler</Button>
            <Button size="sm" variant="primary" disabled={!suggest.some((s) => s.on)} onClick={accept}>Ajouter {suggest.filter((s) => s.on).length} sous-tâche(s)</Button>
          </div>
        </div>
      )}
      {canEdit && (
        <div className="mt-1 flex h-10 items-center gap-2.5 px-1 text-faint">
          <Plus className="size-4" />
          <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Ajouter une sous-tâche" className="flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint" />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ commentaires & activité
const ACTIVITY_LABEL: Record<string, (d: Record<string, unknown>) => string> = {
  "task.created": () => "a créé la tâche",
  "task.completed": (d) => (d.to ? "a terminé la tâche" : "a rouvert la tâche"),
  "task.assignee_id": () => "a changé le responsable",
  "task.due_on": (d) => (d.to ? `a fixé l'échéance au ${shortDate(String(d.to))}` : "a retiré l'échéance"),
  "task.section_id": () => "a déplacé la tâche",
  "task.priority": (d) => `a changé la priorité (${d.to})`,
  "task.title": () => "a renommé la tâche",
  "task.description": () => "a modifié la description",
  "task.tags": () => "a modifié les étiquettes",
  "task.start_on": () => "a changé la date de début",
  "ai.approved": (d) => `a autorisé : ${d.summary}`,
  "ai.rejected": (d) => `a refusé : ${d.summary}`,
};

function Conversation({ t, canComment, memberIds }: { t: TaskDetail; canComment: boolean; memberIds: string[] }) {
  const users = useUserMap();
  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const items = useMemo(() => t.activity.filter((a) => ACTIVITY_LABEL[a.kind]), [t.activity]);
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-1 border-b border-line">
        {(["comments", "activity"] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-2 pb-2 text-[13px] font-medium", tab === k ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg")}>
            {k === "comments" ? `Commentaires${t.comments.length ? ` · ${t.comments.length}` : ""}` : "Historique"}
          </button>
        ))}
      </div>
      {tab === "comments" ? (
        <div className="space-y-4">
          {t.comments.length === 0 && <p className="text-[13px] text-faint">Pas encore de commentaire. Écrivez @Atlas ou @Nova pour solliciter un coéquipier IA.</p>}
          {t.comments.map((c) => <CommentItem key={c.id} c={c} taskId={t.id} isAdmin={t.role === "admin"} />)}
          {canComment && <Composer taskId={t.id} memberIds={memberIds} />}
        </div>
      ) : (
        <ol className="space-y-2.5">
          {items.map((a) => (
            <li key={a.id} className="flex items-start gap-2.5 text-[12.5px]">
              <Avatar user={users.get(a.actor_id)} size={18} />
              <span className="min-w-0 flex-1 text-muted"><span className="font-medium text-fg">{users.get(a.actor_id)?.name}</span> {ACTIVITY_LABEL[a.kind](a.data)}</span>
              <span className="shrink-0 text-faint">{ago(a.created_at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CommentItem({ c, taskId, isAdmin }: { c: TaskDetail["comments"][number]; taskId: string; isAdmin: boolean }) {
  const users = useUserMap();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(c.body);
  const a = users.get(c.author_id);
  const mine = me?.id === c.author_id;
  const refresh = () => qc.invalidateQueries({ queryKey: ["task", taskId] });
  const save = async () => {
    try { await api.patch(`/api/comments/${c.id}`, { body: v }); setEditing(false); refresh(); } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async () => {
    try { await api.del(`/api/comments/${c.id}`); toast.success("Commentaire supprimé"); refresh(); } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="group flex gap-3">
      <Avatar user={a} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">{a?.name}</span>
          {a?.is_ai && <AiBadge />}
          <span className="text-[12px] text-faint">{ago(c.created_at)}{c.edited_at && " · modifié"}</span>
          {(mine || isAdmin) && !editing && (
            <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {mine && <IconButton size="sm" label="Modifier le commentaire" onClick={() => { setV(c.body); setEditing(true); }}><Pencil className="size-3.5" /></IconButton>}
              <IconButton size="sm" label="Supprimer le commentaire" onClick={remove}><Trash2 className="size-3.5" /></IconButton>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)} rows={3} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
              className="w-full resize-y rounded-lg border border-line-strong bg-panel px-2.5 py-2 text-[13.5px] outline-none focus:border-ai-line" />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button size="sm" onClick={() => setEditing(false)}>Annuler</Button>
              <Button size="sm" variant="primary" disabled={!v.trim()} onClick={save}>Enregistrer</Button>
            </div>
          </div>
        ) : (
          <div className={cn("mt-1 text-[13.5px] leading-relaxed", a?.is_ai && "rounded-xl border border-ai-line/60 bg-ai-soft/40 px-3 py-2")}><Markdown text={c.body} /></div>
        )}
      </div>
    </div>
  );
}

function Composer({ taskId, memberIds }: { taskId: string; memberIds: string[] }) {
  const users = useUserMap();
  const qc = useQueryClient();
  const [v, setV] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mention = v.match(/@(\p{L}*)$/u);
  const options = mention ? memberIds.map((id) => users.get(id)!).filter((u) => u && u.id !== "ai_cadence" && u.name.toLowerCase().startsWith(mention[1].toLowerCase())).slice(0, 6) : [];
  const insert = (name: string) => { setV(v.replace(/@(\p{L}*)$/u, `@${name.split(" ")[0]} `)); ref.current?.focus(); };
  const send = async () => {
    if (!v.trim()) return;
    setSending(true);
    try { await api.post(`/api/tasks/${taskId}/comments`, { body: v }); setV(""); qc.invalidateQueries({ queryKey: ["task", taskId] }); }
    catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  };
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = Math.min(220, Math.max(44, el.scrollHeight)) + "px"; } }, [v]);
  return (
    <div className="relative rounded-xl border border-line bg-panel shadow-sm focus-within:border-line-strong">
      {options.length > 0 && (
        <div className="absolute bottom-full left-2 mb-1 w-60 rounded-xl border border-line bg-raised p-1 shadow-lg">
          {options.map((u) => (
            <button key={u.id} onClick={() => insert(u.name)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover">
              <Avatar user={u} size={18} /><span className="flex-1">{u.name}</span>{u.is_ai && <AiBadge />}
            </button>
          ))}
        </div>
      )}
      <textarea ref={ref} value={v} onChange={(e) => setV(e.target.value)} placeholder="Écrire un commentaire… (@ pour mentionner)"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] outline-none placeholder:text-faint" />
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="flex items-center gap-1 pl-1 text-[11.5px] text-faint"><Hash className="size-3" />⌘ Entrée pour envoyer</span>
        <Button size="sm" variant="primary" disabled={!v.trim()} loading={sending} icon={<Send className="size-3.5" />} onClick={send}>Envoyer</Button>
      </div>
    </div>
  );
}

export function SubtaskProgress({ t }: { t: Task }) {
  if (!t.subtask_count) return null;
  return <span className="inline-flex items-center gap-1 text-[12px] tabular text-faint"><ListChecks className="size-3.5" />{t.subtask_done}/{t.subtask_count}</span>;
}

export function TaskMetaRow({ t }: { t: Task }) {
  return (
    <span className="flex items-center gap-2">
      <SubtaskProgress t={t} />
      {t.comment_count ? <span className="inline-flex items-center gap-1 text-[12px] tabular text-faint"><MessageSquare className="size-3.5" />{t.comment_count}</span> : null}
      {t.tags.slice(0, 2).map((tg) => <Chip key={tg}>{tg}</Chip>)}
    </span>
  );
}
