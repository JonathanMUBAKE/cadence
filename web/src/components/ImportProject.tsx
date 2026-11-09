import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, FileUp, Sparkles } from "lucide-react";
import { Button, Dialog, Spinner, cn } from "./ui";
import { AiBadge } from "./ai";
import { DueChip, DuePicker } from "./pickers";
import { useAiStatus, useMe, useTeams, useUsers } from "@/lib/hooks";
import { PRIORITIES } from "@/lib/format";
import { api } from "@/lib/api";
import type { ImportAnalysis, ImportProposal, ImportSubtask, ImportTask, Priority, ProjectDetail } from "@/lib/types";

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".docx,.doc,.xlsx,.xls,.pdf,.csv,.txt,.md";
type SubRow = ImportSubtask & { on: boolean };
type TaskRow = Omit<ImportTask, "subtasks"> & { on: boolean; subtasks: SubRow[] };
const field = "rounded-md bg-transparent text-[12.5px] text-muted outline-none hover:bg-hover";

/** Un fichier Word ou Excel devient un projet : l'IA propose, la personne relit, puis seulement le projet est créé. */
export function ImportProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const { data: teams } = useTeams();
  const { data: me } = useMe();
  const { data: users } = useUsers();
  const { data: ai } = useAiStatus();
  const people = useMemo(() => (users ?? []).filter((u) => !u.is_ai), [users]);
  const orgAdmin = ["owner", "admin"].includes(me?.orgs.find((o) => o.id === me.org_id)?.role ?? "");
  const myTeams = (teams ?? []).filter((t) => t.my_role || orgAdmin);
  const [teamId, setTeamId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);
  const [analysis, setAnalysis] = useState<Pick<ImportAnalysis, "filename" | "truncated"> | null>(null);
  const [draft, setDraft] = useState<Omit<ImportProposal, "tasks"> | null>(null);
  const [rows, setRows] = useState<TaskRow[]>([]);

  useEffect(() => {
    if (open) {
      setAnalysis(null);
      setDraft(null);
      setRows([]);
      setTeamId(myTeams[0]?.id ?? "");
    }
  }, [open]);

  const read = async (file?: File) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error("Fichier trop volumineux : 10 Mo au maximum");
      return;
    }
    setLoading(true);
    try {
      const { proposal, ...meta } = await api.upload<ImportAnalysis>("/api/import/analyze", file);
      const { tasks, ...rest } = proposal;
      setAnalysis(meta);
      setDraft(rest);
      setRows(tasks.map((t) => ({ ...t, on: true, subtasks: t.subtasks.map((s) => ({ ...s, on: true })) })));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      if (input.current) input.current.value = "";
    }
  };

  const patch = (i: number, p: Partial<TaskRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const patchSub = (i: number, k: number, p: Partial<SubRow>) =>
    patch(i, { subtasks: rows[i].subtasks.map((s, j) => (j === k ? { ...s, ...p } : s)) });
  const chosen = rows.filter((r) => r.on);
  const subCount = chosen.reduce((n, r) => n + r.subtasks.filter((s) => s.on).length, 0);
  const newMembers = new Set(
    chosen
      .flatMap((r) => [r.assignee_id, ...r.subtasks.filter((s) => s.on).map((s) => s.assignee_id)])
      .filter((id): id is string => !!id && id !== me?.id),
  );

  const create = async () => {
    if (!draft || !analysis) return;
    setSaving(true);
    try {
      const p = await api.post<ProjectDetail>("/api/import/create", {
        name: draft.name,
        description: draft.description,
        due_on: draft.due_on,
        team_id: teamId || null,
        access: teamId ? "team" : "private",
        filename: analysis.filename,
        sections: draft.sections,
        tasks: chosen.map(({ on: _on, subtasks, ...t }) => ({
          ...t,
          subtasks: subtasks.filter((s) => s.on && s.title.trim()).map(({ on: _s, ...s }) => s),
        })),
      });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      nav(`/projects/${p.id}`);
      toast.success("Projet créé depuis le fichier");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = (
    <span className="flex items-center gap-2">
      <Sparkles className="size-4 text-ai-fg" />
      Importer un projet
    </span>
  );
  if (!draft) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        width={560}
        title={title}
        description="L'IA lit votre fichier et propose le projet, ses sections, ses tâches et sous-tâches. Rien n'est créé avant votre relecture."
        footer={<Button onClick={() => onOpenChange(false)}>Annuler</Button>}
      >
        <button
          type="button"
          disabled={loading}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void read(e.dataTransfer.files[0]);
          }}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
            over ? "border-ai-line bg-ai-soft/50" : "border-line-strong hover:bg-hover",
          )}
        >
          {loading ? (
            <>
              <Spinner className="size-5" />
              <span className="text-[14px] font-medium">L'IA lit le document…</span>
              <span className="text-[12.5px] text-muted">Cela peut prendre une minute pour un long fichier.</span>
            </>
          ) : (
            <>
              <FileUp className="size-6 text-muted" />
              <span className="text-[14px] font-medium">Déposez un fichier ou cliquez pour le choisir</span>
              <span className="text-[12.5px] text-muted">Word, Excel, PDF, CSV ou texte · 10 Mo maximum</span>
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          aria-label="Choisir un fichier à importer"
          onChange={(e) => void read(e.target.files?.[0])}
        />
        {ai?.provider === "demo" && (
          <p className="mt-3 text-[12.5px] text-faint">
            Mode démo : sans clé ANTHROPIC_API_KEY, seuls les tableaux avec en-têtes et les plans à titres et puces sont
            compris.
          </p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={820}
      title={title}
      description={`Proposition tirée de « ${analysis?.filename} ». Corrigez ce qui doit l'être, décochez ce qui ne convient pas.`}
      footer={
        <>
          <Button
            onClick={() => {
              setDraft(null);
              setRows([]);
            }}
          >
            Choisir un autre fichier
          </Button>
          <Button variant="primary" disabled={!draft.name.trim()} loading={saving} onClick={create}>
            Créer le projet · {chosen.length} tâche(s), {subCount} sous-tâche(s)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <input
          value={draft.name}
          aria-label="Nom du projet"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="w-full bg-transparent text-[18px] font-semibold outline-none"
        />
        <textarea
          value={draft.description}
          aria-label="Description du projet"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          placeholder="Objectif du projet"
          className="w-full resize-none rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13.5px] outline-none focus:border-line-strong"
        />
        <div className="flex flex-wrap items-center gap-4 text-[12.5px] text-muted">
          <label className="flex items-center gap-2">
            Équipe
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="h-8 rounded-lg border border-line bg-bg/60 px-2 text-[13px] text-fg outline-none"
            >
              {orgAdmin && <option value="">Aucune équipe</option>}
              {myTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <span className="flex items-center gap-1">
            Échéance
            <DuePicker value={draft.due_on} onChange={(d) => setDraft({ ...draft, due_on: d })}>
              <button className="rounded-md px-1.5 py-1 hover:bg-hover">
                <DueChip due={draft.due_on} empty={<span className="text-faint">Aucune</span>} />
              </button>
            </DuePicker>
          </span>
          {newMembers.size > 0 && (
            <span>{newMembers.size} personne(s) assignée(s) seront ajoutées au projet si besoin.</span>
          )}
        </div>
        {(analysis?.truncated || draft.notes.length > 0) && (
          <div className="rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            {analysis?.truncated && (
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" />
                Le document est très long : seule sa première partie a été lue.
              </p>
            )}
            {draft.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <AiBadge label={`${rows.length} tâche(s) proposée(s)`} />
          <span className="text-[12.5px] text-muted">{draft.sections.length} section(s)</span>
        </div>
        {rows.length === 0 && (
          <p className="text-[13px] text-muted">
            Aucune tâche n'a été reconnue dans ce fichier. Vous pouvez créer le projet vide ou choisir un autre fichier.
          </p>
        )}
        {draft.sections.map((section) => {
          const inSection = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.section === section);
          if (!inSection.length) return null;
          return (
            <section key={section}>
              <h4 className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-faint">{section}</h4>
              <div className="space-y-1.5">
                {inSection.map(({ r, i }) => (
                  <div
                    key={i}
                    className={cn("rounded-xl border border-line bg-bg/40 px-3 py-2", !r.on && "opacity-50")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="checkbox"
                        checked={r.on}
                        aria-label={`Garder ${r.title}`}
                        onChange={() => patch(i, { on: !r.on })}
                        className="size-4 accent-[var(--ai)]"
                      />
                      <input
                        value={r.title}
                        aria-label="Titre de la tâche"
                        onChange={(e) => patch(i, { title: e.target.value })}
                        className={cn(
                          "min-w-[180px] flex-1 bg-transparent text-[13.5px] font-medium outline-none",
                          r.completed && "line-through",
                        )}
                      />
                      <select
                        value={r.section}
                        aria-label="Section"
                        onChange={(e) => patch(i, { section: e.target.value })}
                        className={cn(field, "max-w-[120px]")}
                      >
                        {draft.sections.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <select
                        value={r.assignee_id ?? ""}
                        aria-label="Responsable"
                        onChange={(e) => patch(i, { assignee_id: e.target.value || null })}
                        className={cn(field, "max-w-[130px]")}
                      >
                        <option value="">Personne</option>
                        {people.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={r.priority}
                        aria-label="Priorité"
                        onChange={(e) => patch(i, { priority: e.target.value as Priority })}
                        className={field}
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <DuePicker value={r.due_on} onChange={(d) => patch(i, { due_on: d })}>
                        <button className="rounded-md px-1.5 py-1 hover:bg-hover">
                          <DueChip due={r.due_on} empty={<span className="text-[12px] text-faint">Échéance</span>} />
                        </button>
                      </DuePicker>
                    </div>
                    {r.subtasks.length > 0 && (
                      <ul className="mt-1.5 space-y-1 pl-6">
                        {r.subtasks.map((s, k) => (
                          <li key={k} className={cn("flex flex-wrap items-center gap-2", !s.on && "opacity-50")}>
                            <input
                              type="checkbox"
                              checked={s.on}
                              aria-label={`Garder ${s.title}`}
                              onChange={() => patchSub(i, k, { on: !s.on })}
                              className="size-3.5 accent-[var(--ai)]"
                            />
                            <input
                              value={s.title}
                              aria-label="Titre de la sous-tâche"
                              onChange={(e) => patchSub(i, k, { title: e.target.value })}
                              className="min-w-[160px] flex-1 bg-transparent text-[13px] outline-none"
                            />
                            <select
                              value={s.assignee_id ?? ""}
                              aria-label="Responsable de la sous-tâche"
                              onChange={(e) => patchSub(i, k, { assignee_id: e.target.value || null })}
                              className={cn(field, "max-w-[130px]")}
                            >
                              <option value="">Personne</option>
                              {people.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name}
                                </option>
                              ))}
                            </select>
                            <DueChip due={s.due_on} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
