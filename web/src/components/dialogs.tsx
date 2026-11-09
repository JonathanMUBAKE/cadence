import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileUp, Flag, Sparkles, Trash2, Wand2 } from "lucide-react";
import { ImportProjectDialog } from "./ImportProject";
import { Avatar, Button, Dialog, PROJECT_ICONS, ProjectIcon, cn } from "./ui";
import { AssigneePicker, DueChip, DuePicker, PriorityFlag, PriorityPicker } from "./pickers";
import { AiBadge } from "./ai";
import { useMe, useProject, useProjects, useTeams, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { api } from "@/lib/api";
import type { ParsedTask, ProjectDetail, StatusProposal } from "@/lib/types";
import { STATUS } from "@/lib/format";

const COLORS = ["#6E56CF", "#0090FF", "#12A594", "#30A46C", "#F76B15", "#E5484D", "#D6409F", "#8E8C99"];
const TEMPLATES: { id: string; label: string; hint: string; sections: string[] }[] = [
  { id: "kanban", label: "Kanban", hint: "À faire, En cours, En revue, Terminé", sections: ["À faire", "En cours", "En revue", "Terminé"] },
  { id: "product", label: "Développement produit", hint: "Backlog → Livré", sections: ["Backlog", "À faire", "En cours", "En revue", "Terminé"] },
  { id: "launch", label: "Lancement", hint: "Idées, Production, Validation, Publié", sections: ["Idées", "Production", "Validation", "Publié"] },
  { id: "simple", label: "Simple", hint: "À faire, Terminé", sections: ["À faire", "Terminé"] },
];

export function NewProjectDialog() {
  const shell = useShell();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [icon, setIcon] = useState("rocket");
  const [template, setTemplate] = useState("kanban");
  const [due, setDue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const { data: teams } = useTeams();
  const { data: me } = useMe();
  const orgAdmin = ["owner", "admin"].includes(me?.orgs.find((o) => o.id === me.org_id)?.role ?? "");
  const myTeams = (teams ?? []).filter((t) => t.my_role || orgAdmin);
  const [teamId, setTeamId] = useState<string>("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [access, setAccess] = useState<"team" | "private">("team");
  useEffect(() => { if (shell.newProject) { setTeamId(shell.newProjectTeam ?? myTeams[0]?.id ?? ""); setKey(""); setKeyTouched(false); setAccess("team"); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shell.newProject]);
  const autoKey = name.normalize("NFD").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().replace(/^[0-9]+/, "").padEnd(3, "X").slice(0, 4);
  const effectiveKey = keyTouched ? key : name.trim() ? autoKey : "";
  const submit = async () => {
    setSaving(true);
    try {
      const p = await api.post<ProjectDetail>("/api/projects", { name, description, color, icon, due_on: due, team_id: teamId || null, key: effectiveKey || undefined, access });
      // Sections du modèle choisi (le serveur crée le modèle Kanban par défaut)
      const tpl = TEMPLATES.find((t) => t.id === template)!;
      if (template !== "kanban") {
        for (const s of tpl.sections) await api.post(`/api/projects/${p.id}/sections`, { name: s });
        for (const s of p.sections) await api.del(`/api/sections/${s.id}`);
      }
      qc.invalidateQueries({ queryKey: ["projects"] });
      shell.setNewProject(false); setName(""); setDescription("");
      nav(`/projects/${p.id}`);
      toast.success("Projet créé");
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };
  return (
    <>
    <ImportProjectDialog open={importing} onOpenChange={setImporting} />
    <Dialog open={shell.newProject} onOpenChange={shell.setNewProject} title="Nouveau projet" description="Vous en serez administrateur. Ajoutez ensuite vos coéquipiers, humains et IA."
      footer={<><Button variant="ai" className="mr-auto" icon={<FileUp className="size-3.5" />} onClick={() => { shell.setNewProject(false); setImporting(true); }}>Importer un fichier</Button><Button onClick={() => shell.setNewProject(false)}>Annuler</Button><Button variant="primary" disabled={!name.trim()} loading={saving} onClick={submit}>Créer le projet</Button></>}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <ProjectIcon icon={icon} color={color} size={40} />
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du projet" className="h-10 flex-1 bg-transparent text-[18px] font-semibold outline-none placeholder:text-faint" />
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Objectif du projet (l'IA s'en sert comme contexte)"
          className="w-full resize-none rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13.5px] outline-none focus:border-line-strong" />
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex gap-1.5">{COLORS.map((c) => <button key={c} aria-label={`Couleur ${c}`} onClick={() => setColor(c)} className={cn("size-6 rounded-full ring-offset-2 ring-offset-panel", color === c && "ring-2 ring-fg")} style={{ background: c }} />)}</div>
          <div className="flex gap-1">{PROJECT_ICONS.map((i) => <button key={i} aria-label={`Icône ${i}`} onClick={() => setIcon(i)} className={cn("rounded-lg p-1", icon === i ? "bg-active" : "hover:bg-hover")}><ProjectIcon icon={i} color={color} size={22} /></button>)}</div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px]">
          <label className="text-[12px] font-medium text-muted">Équipe
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] text-fg outline-none">
              {orgAdmin && <option value="">Aucune équipe</option>}
              {myTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="text-[12px] font-medium text-muted">Clé
            <input value={effectiveKey} onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)); }} placeholder="APP"
              className="mt-1 h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 font-mono text-[13.5px] uppercase text-fg outline-none" />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {([["team", "Toute l'équipe", "Les membres de l'équipe y ont accès"], ["private", "Privé", "Seulement les personnes ajoutées"]] as const).map(([v, l, h]) => (
            <button key={v} onClick={() => setAccess(v)} className={cn("flex-1 rounded-xl border p-3 text-left", access === v ? "border-fg bg-hover" : "border-line hover:border-line-strong")}>
              <p className="text-[13px] font-medium">{l}</p><p className="mt-0.5 text-[12px] text-faint">{h}</p>
            </button>
          ))}
        </div>
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-muted">Modèle</p>
          <div className="grid grid-cols-2 gap-2">
            {TEMPLATES.map((t) => (
              <button key={t.id} onClick={() => setTemplate(t.id)} className={cn("rounded-xl border p-3 text-left", template === t.id ? "border-fg bg-hover" : "border-line hover:border-line-strong")}>
                <p className="text-[13px] font-medium">{t.label}</p><p className="mt-0.5 text-[12px] text-faint">{t.hint}</p>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[13px]"><span className="text-muted">Échéance</span>
          <DuePicker value={due} onChange={setDue}><button className="rounded-md px-2 py-1 hover:bg-hover"><DueChip due={due} empty={<span className="text-faint">Aucune</span>} /></button></DuePicker>
        </div>
      </div>
    </Dialog>
    </>
  );
}

/** Notes en vrac → tâches, grâce à l'IA, avec relecture avant création. */
export function QuickAddDialog() {
  const shell = useShell();
  const { data: projects } = useProjects();
  const editable = projects?.filter((p) => p.role === "editor" || p.role === "admin") ?? [];
  const [projectId, setProjectId] = useState<string | null>(null);
  const { data: project } = useProject(projectId ?? undefined);
  const users = useUserMap();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [items, setItems] = useState<ParsedTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (shell.quickAdd.open) { setProjectId(shell.quickAdd.projectId ?? editable[0]?.id ?? null); setItems(null); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shell.quickAdd.open]);
  const analyse = async () => {
    setLoading(true);
    try { setItems((await api.post<{ tasks: ParsedTask[] }>(`/api/projects/${projectId}/ai/parse`, { text })).tasks); }
    catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  };
  const create = async () => {
    setLoading(true);
    try {
      await api.post(`/api/projects/${projectId}/tasks/bulk`, { tasks: items!.map((t) => ({ title: t.title, description: t.description, assignee_id: t.assignee_id, due_on: t.due_on, priority: t.priority, section_id: t.section_id })) });
      toast.success(`${items!.length} tâche(s) créée(s)`);
      qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["projects"] });
      setText(""); setItems(null); shell.closeQuickAdd();
    } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  };
  const patch = (i: number, p: Partial<ParsedTask>) => setItems(items!.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Dialog open={shell.quickAdd.open} onOpenChange={(v) => !v && shell.closeQuickAdd()} width={680}
      title={<span className="flex items-center gap-2"><Wand2 className="size-4 text-ai-fg" />Créer des tâches à partir de notes</span>}
      description="Collez un compte rendu de réunion, un e-mail ou une liste : l'IA en extrait les tâches, vous relisez avant de créer."
      footer={items
        ? <><Button onClick={() => setItems(null)}>Retour</Button><Button variant="primary" disabled={!items.length} loading={loading} onClick={create}>Créer {items.length} tâche(s)</Button></>
        : <><Button onClick={shell.closeQuickAdd}>Annuler</Button><Button variant="ai" icon={<Sparkles className="size-3.5" />} disabled={!text.trim() || !projectId} loading={loading} onClick={analyse}>Extraire les tâches</Button></>}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {editable.map((p) => (
          <button key={p.id} onClick={() => { setProjectId(p.id); setItems(null); }} className={cn("flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12.5px]", projectId === p.id ? "border-fg bg-hover" : "border-line text-muted hover:text-fg")}>
            <ProjectIcon icon={p.icon} color={p.color} size={16} />{p.name}
          </button>
        ))}
      </div>
      {!items ? (
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={9}
          placeholder={"Réunion produit du lundi\n- Karim corrige le crash du panier, urgent\n- Chloé finalise les maquettes du tableau de bord pour vendredi\n- Préparer la démo client la semaine prochaine"}
          className="w-full resize-y rounded-xl border border-line bg-bg/60 px-3.5 py-3 text-[13.5px] leading-relaxed outline-none focus:border-ai-line" />
      ) : (
        <div className="space-y-1.5">
          <div className="mb-2 flex items-center gap-2"><AiBadge label={`${items.length} tâche(s) détectée(s)`} /><span className="text-[12.5px] text-muted">Modifiez avant de valider</span></div>
          {items.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg/40 px-3 py-2">
              <input value={t.title} onChange={(e) => patch(i, { title: e.target.value })} className="min-w-[200px] flex-1 bg-transparent text-[13.5px] font-medium outline-none" />
              <AssigneePicker memberIds={project?.members.map((m) => m.user_id) ?? []} value={t.assignee_id} onChange={(id) => patch(i, { assignee_id: id })} align="end">
                <button className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-hover"><Avatar user={t.assignee_id ? users.get(t.assignee_id) : null} size={18} />{t.assignee_id ? users.get(t.assignee_id)?.name.split(" ")[0] : ""}</button>
              </AssigneePicker>
              <DuePicker value={t.due_on} onChange={(d) => patch(i, { due_on: d })}><button className="rounded-md px-1.5 py-1 hover:bg-hover"><DueChip due={t.due_on} empty={<span className="text-[12px] text-faint">Échéance</span>} /></button></DuePicker>
              <PriorityPicker value={t.priority} onChange={(p) => patch(i, { priority: p })}><button className="rounded-md px-1.5 py-1 hover:bg-hover">{t.priority === "none" ? <Flag className="size-3.5 text-faint" /> : <PriorityFlag p={t.priority} />}</button></PriorityPicker>
              <button aria-label="Retirer" onClick={() => setItems(items.filter((_, j) => j !== i))} className="rounded-md p-1 text-faint hover:bg-hover hover:text-danger"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Point d'avancement rédigé par l'IA, relu puis publié à l'équipe. */
export function StatusUpdateDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [p, setP] = useState<StatusProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (!open) return;
    setP(null); setLoading(true);
    api.post<StatusProposal>(`/api/projects/${projectId}/ai/status`).then(setP, (e) => { toast.error(e.message); onOpenChange(false); }).finally(() => setLoading(false));
  }, [open, projectId, onOpenChange]);
  const publish = async () => {
    await api.post(`/api/projects/${projectId}/updates`, { ...p, ai: true }).then(() => { toast.success("Point d'avancement publié"); qc.invalidateQueries({ queryKey: ["updates", projectId] }); qc.invalidateQueries({ queryKey: ["projects"] }); qc.invalidateQueries({ queryKey: ["project", projectId] }); onOpenChange(false); }, (e) => toast.error(e.message));
  };
  const list = (k: "risks" | "next_steps", label: string) => p && (
    <div>
      <p className="mb-1 text-[12px] font-medium uppercase tracking-wider text-faint">{label}</p>
      {p[k].map((r, i) => (
        <div key={i} className="group flex items-center gap-2">
          <span className="text-faint">•</span>
          <input value={r} onChange={(e) => setP({ ...p, [k]: p[k].map((x, j) => (j === i ? e.target.value : x)) })} className="flex-1 bg-transparent py-1 text-[13.5px] outline-none" />
          <button aria-label="Retirer" onClick={() => setP({ ...p, [k]: p[k].filter((_, j) => j !== i) })} className="text-faint opacity-0 group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={620}
      title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-ai-fg" />Point d'avancement</span>}
      description="Rédigé par l'IA à partir des tâches et de l'activité récente. Relisez, ajustez, publiez."
      footer={<><Button onClick={() => onOpenChange(false)}>Annuler</Button><Button variant="primary" disabled={!p} onClick={publish}>Publier à l'équipe</Button></>}>
      {loading || !p ? (
        <div className="space-y-3 py-2">{[80, 100, 92, 60].map((w, i) => <div key={i} className="h-4 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />)}<p className="pt-2 text-[13px] text-muted">L'IA analyse le projet…</p></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {(["on_track", "at_risk", "off_track"] as const).map((s) => (
              <button key={s} onClick={() => setP({ ...p, status: s })} className={cn("flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium", p.status === s ? "border-transparent" : "border-line text-muted")}
                style={p.status === s ? { background: STATUS[s].soft, color: STATUS[s].color } : undefined}>
                <span className="size-2 rounded-full" style={{ background: STATUS[s].color }} />{STATUS[s].label}
              </button>
            ))}
          </div>
          <input value={p.headline} onChange={(e) => setP({ ...p, headline: e.target.value })} className="w-full bg-transparent text-[18px] font-semibold outline-none" />
          <textarea value={p.summary} onChange={(e) => setP({ ...p, summary: e.target.value })} rows={3} className="w-full resize-none rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13.5px] outline-none" />
          {list("risks", "Risques")}
          {list("next_steps", "Prochaines étapes")}
        </div>
      )}
    </Dialog>
  );
}
