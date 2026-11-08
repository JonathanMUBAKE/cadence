import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Avatar, Button, Dialog, Empty, IconButton, cn } from "@/components/ui";
import { RUN_STATUS, RunTimeline } from "@/components/ai";
import { useAgents, useRules, useRuns, useUserMap } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { AiRule } from "@/lib/types";
import type { ViewProps } from "@/pages/Project";

const TRIGGERS: Record<AiRule["trigger"], string> = {
  task_created: "Quand une tâche est créée",
  task_moved: "Quand une tâche arrive dans une section",
  task_overdue: "Quand une tâche passe en retard",
};

export function AutomationsView({ project }: ViewProps) {
  const { data: rules } = useRules(project.id);
  const { data: runs } = useRuns({ projectId: project.id });
  const users = useUserMap();
  const shell = useShell();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<AiRule> | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const isAdmin = project.role === "admin";
  const save = async (r: Partial<AiRule>) => {
    await api.post(`/api/projects/${project.id}/ai/rules`, r).then(() => { qc.invalidateQueries({ queryKey: ["rules", project.id] }); setEditing(null); toast.success("Règle enregistrée"); }, (e) => toast.error(e.message));
  };
  const section = (id: string | null) => project.sections.find((s) => s.id === id)?.name;

  return (
    <div className="mx-auto max-w-[1000px] space-y-8 px-4 py-6 sm:px-8">
      <section>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <h2 className="text-[18px] font-semibold">Règles IA</h2>
            <p className="mt-0.5 text-[13px] text-muted">Un déclencheur, une consigne en langage naturel, un coéquipier IA pour l'appliquer. Ses actions passent par vos validations, sauf si vous l'autorisez à agir seul.</p>
          </div>
          {isAdmin && <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ trigger: "task_created", enabled: true, auto_approve: false })}>Nouvelle règle</Button>}
        </div>
        {!rules?.length ? (
          <div className="rounded-2xl border border-dashed border-line-strong"><Empty icon={<Zap className="size-7" />} title="Aucune règle">Par exemple : « Quand une tâche arrive dans En revue, Nova vérifie qu'elle a des critères de test ».</Empty></div>
        ) : (
          <div className="space-y-2.5">
            {rules.map((r) => (
              <div key={r.id} className={cn("flex flex-wrap items-start gap-4 rounded-2xl border border-line bg-panel p-4 shadow-sm", !r.enabled && "opacity-60")}>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ai-soft text-ai-fg"><Zap className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">{r.name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                    {TRIGGERS[r.trigger]}{r.section_id && <> <b className="font-medium text-fg">« {section(r.section_id)} »</b></>}
                    <ArrowRight className="size-3.5" /><Avatar user={users.get(r.agent_id)} size={16} /><b className="font-medium text-fg">{users.get(r.agent_id)?.name}</b>
                    {r.auto_approve ? <span className="text-warning">agit sans validation</span> : <span>demande validation</span>}
                  </p>
                  <p className="mt-2 rounded-lg bg-hover px-3 py-2 text-[13px] leading-relaxed">{r.instructions}</p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1">
                    <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
                      <input type="checkbox" checked={r.enabled} onChange={(e) => save({ ...r, enabled: e.target.checked })} className="accent-[var(--ai)]" />Active
                    </label>
                    <IconButton label="Modifier" onClick={() => setEditing(r)}><Pencil className="size-3.5" /></IconButton>
                    <IconButton label="Supprimer" onClick={() => api.del(`/api/projects/${project.id}/ai/rules/${r.id}`).then(() => qc.invalidateQueries({ queryKey: ["rules", project.id] }))}><Trash2 className="size-3.5" /></IconButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-[18px] font-semibold">Interventions dans ce projet</h2>
        {!runs?.length ? <p className="text-[13px] text-muted">Aucune pour l'instant.</p> : (
          <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
            {runs.map((r) => (
              <div key={r.id} className="border-b border-line last:border-b-0">
                <button onClick={() => setOpenRun(openRun === r.id ? null : r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
                  <Avatar user={users.get(r.agent_id)} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]"><b className="font-medium">{users.get(r.agent_id)?.name}</b> <span className="text-muted">· {r.kind === "rule" ? `règle « ${rules?.find((x) => x.id === r.rule_id)?.name ?? "supprimée"} »` : r.kind === "mention" ? "mention" : "tâche assignée"}</span></span>
                    <span className="text-[11.5px]"><span className={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</span><span className="text-faint"> · {r.step_count} étape(s) · {ago(r.created_at)}</span></span>
                  </span>
                  {r.task_id && <span onClick={(e) => { e.stopPropagation(); shell.openTask(r.task_id!); }} className="text-[12px] text-muted hover:text-fg">Ouvrir la tâche</span>}
                </button>
                {openRun === r.id && <div className="border-t border-line bg-bg/40 px-4 py-4"><RunTimeline runId={r.id} /></div>}
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && <RuleEditor rule={editing} project={project} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function RuleEditor({ rule, project, onClose, onSave }: { rule: Partial<AiRule>; project: ViewProps["project"]; onClose: () => void; onSave: (r: Partial<AiRule>) => void }) {
  const { data: agents } = useAgents();
  const members = (agents ?? []).filter((a) => project.members.some((m) => m.user_id === a.id));
  const [r, setR] = useState<Partial<AiRule>>({ agent_id: members[0]?.id, ...rule });
  const field = "w-full rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13.5px] outline-none focus:border-line-strong";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={rule.id ? "Modifier la règle" : "Nouvelle règle IA"} width={580}
      footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" disabled={!r.name?.trim() || !r.instructions?.trim() || !r.agent_id} onClick={() => onSave(r)}>Enregistrer</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="mb-1 block text-[12px] font-medium text-muted">Nom</span><input autoFocus value={r.name ?? ""} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Triage des bugs" className={field} /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-[12px] font-medium text-muted">Déclencheur</span>
            <select value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value as AiRule["trigger"] })} className={field}>{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="block"><span className="mb-1 block text-[12px] font-medium text-muted">Section</span>
            <select value={r.section_id ?? ""} onChange={(e) => setR({ ...r, section_id: e.target.value || null })} className={field}><option value="">Toutes</option>{project.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        </div>
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-muted">Coéquipier IA</span>
          <div className="flex flex-wrap gap-2">
            {members.map((a) => (
              <button key={a.id} onClick={() => setR({ ...r, agent_id: a.id })} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-left", r.agent_id === a.id ? "border-ai-line bg-ai-soft" : "border-line hover:border-line-strong")}>
                <Avatar user={a} size={22} /><span className="text-[13px] font-medium">{a.name}</span>
              </button>
            ))}
            {members.length === 0 && <p className="text-[13px] text-warning">Ajoutez d'abord un coéquipier IA aux membres du projet.</p>}
          </div>
        </div>
        <label className="block"><span className="mb-1 block text-[12px] font-medium text-muted">Consigne</span>
          <textarea value={r.instructions ?? ""} onChange={(e) => setR({ ...r, instructions: e.target.value })} rows={4} placeholder="Qualifie la tâche : fixe une priorité, demande les étapes de reproduction s'il s'agit d'un bug…" className={cn(field, "resize-y leading-relaxed")} />
        </label>
        <label className="flex items-start gap-2.5 rounded-xl border border-line p-3">
          <input type="checkbox" checked={!!r.auto_approve} onChange={(e) => setR({ ...r, auto_approve: e.target.checked })} className="mt-0.5 accent-[var(--warning)]" />
          <span><span className="block text-[13px] font-medium">Agir sans validation</span><span className="block text-[12px] text-muted">Les actions de cette règle s'exécutent sans attendre d'accord humain. Elles restent journalisées.</span></span>
        </label>
      </div>
    </Dialog>
  );
}
