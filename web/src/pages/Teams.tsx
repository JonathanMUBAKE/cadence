import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Globe2, Lock, LogIn, Plus, UserPlus, Users, X } from "lucide-react";
import { Avatar, AvatarStack, Button, Chip, Dialog, Empty, IconButton, ProgressRing, ProjectIcon, Spinner, cn } from "@/components/ui";
import { AssigneePicker } from "@/components/pickers";
import { useMe, useTeam, useTeams, useUnits, useUserMap, useUsers } from "@/lib/hooks";
import { useShell } from "@/lib/shell";
import { STATUS } from "@/lib/format";
import { api } from "@/lib/api";
import type { Team, TeamVisibility } from "@/lib/types";

export const VISIBILITY: Record<TeamVisibility, { label: string; hint: string; icon: typeof Globe2 }> = {
  public: { label: "Publique", hint: "Tout le monde peut la rejoindre et voir ses projets", icon: Globe2 },
  request: { label: "Sur demande", hint: "Visible de tous, adhésion validée par un responsable", icon: LogIn },
  private: { label: "Privée", hint: "Invisible hors de ses membres", icon: Lock },
};
const COLORS = ["#6E56CF", "#0090FF", "#12A594", "#30A46C", "#F76B15", "#E5484D", "#D6409F", "#8E8C99"];

function JoinButton({ t }: { t: Team }) {
  const qc = useQueryClient();
  if (t.my_role) return <Chip tone="success" icon={<Check className="size-3" />}>{t.my_role === "lead" ? "Responsable" : "Membre"}</Chip>;
  if (t.request_pending) return <Chip>Demande envoyée</Chip>;
  if (t.visibility === "private") return null;
  return (
    <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={(e) => {
      e.preventDefault();
      api.post<{ result: string }>(`/api/teams/${t.id}/join`).then((r) => { qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["team", t.id] }); qc.invalidateQueries({ queryKey: ["projects"] }); toast.success(r.result === "joined" ? `Vous avez rejoint « ${t.name} »` : "Demande envoyée aux responsables"); }, (er) => toast.error(er.message));
    }}>{t.visibility === "public" ? "Rejoindre" : "Demander à rejoindre"}</Button>
  );
}

export function TeamsPage() {
  const { data: teams, isLoading } = useTeams();
  const { data: units } = useUnits();
  const { data: me } = useMe();
  const [creating, setCreating] = useState(false);
  const guest = me?.orgs.find((o) => o.id === me.org_id)?.role === "guest";
  const unitName = (id: string | null) => units?.find((u) => u.id === id)?.name;
  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Équipes</h1>
          <p className="mt-1 text-[13px] text-muted">Chaque projet appartient à une équipe. Ses membres y ont accès en édition, ses responsables l'administrent.</p>
        </div>
        {!guest && <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>Nouvelle équipe</Button>}
      </header>
      {isLoading ? <Spinner /> : !teams?.length ? <Empty title="Aucune équipe visible" /> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => {
            const V = VISIBILITY[t.visibility];
            return (
              <Link key={t.id} to={`/teams/${t.id}`} className="group flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 shadow-sm transition-[border-color,transform] hover:-translate-y-px hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: t.color }}><Users className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{t.name}</span>
                    <span className="block truncate text-[12px] text-muted">{unitName(t.unit_id) ?? "Sans entité"}</span>
                  </span>
                </div>
                {t.description && <p className="line-clamp-2 text-[13px] text-muted">{t.description}</p>}
                <div className="mt-auto flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <span className="flex items-center gap-1" title={V.hint}><V.icon className="size-3.5" />{V.label}</span>
                  <span className="tabular">· {t.member_count} membre(s) · {t.project_count} projet(s)</span>
                  <span className="ml-auto"><JoinButton t={t} /></span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <TeamDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function TeamDialog({ open, onOpenChange, team }: { open: boolean; onOpenChange: (v: boolean) => void; team?: Team }) {
  const { data: units } = useUnits();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [visibility, setVisibility] = useState<TeamVisibility>(team?.visibility ?? "public");
  const [unit, setUnit] = useState<string>(team?.unit_id ?? "");
  const [color, setColor] = useState(team?.color ?? COLORS[0]);
  const save = async () => {
    const body = { name, description, visibility, unit_id: unit || null, color };
    try {
      if (team) { await api.patch(`/api/teams/${team.id}`, body); toast.success("Équipe mise à jour"); }
      else { const t = await api.post<Team>("/api/teams", body); toast.success("Équipe créée"); nav(`/teams/${t.id}`); }
      qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["team"] }); qc.invalidateQueries({ queryKey: ["projects"] }); onOpenChange(false);
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={team ? "Réglages de l'équipe" : "Nouvelle équipe"} width={520}
      footer={<><Button onClick={() => onOpenChange(false)}>Annuler</Button><Button variant="primary" disabled={!name.trim()} onClick={save}>{team ? "Enregistrer" : "Créer l'équipe"}</Button></>}>
      <div className="space-y-4">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de l'équipe" aria-label="Nom de l'équipe" className="h-10 w-full bg-transparent text-[18px] font-semibold outline-none placeholder:text-faint" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Mission de l'équipe" aria-label="Description" className="w-full resize-none rounded-lg border border-line bg-bg/60 px-3 py-2 text-[13.5px] outline-none" />
        <div className="grid gap-2">
          {(Object.keys(VISIBILITY) as TeamVisibility[]).map((v) => {
            const V = VISIBILITY[v];
            return (
              <button key={v} onClick={() => setVisibility(v)} className={cn("flex items-center gap-3 rounded-xl border p-3 text-left", visibility === v ? "border-fg bg-hover" : "border-line hover:border-line-strong")}>
                <V.icon className="size-4 text-muted" /><span><span className="block text-[13px] font-medium">{V.label}</span><span className="block text-[12px] text-faint">{V.hint}</span></span>
              </button>
            );
          })}
        </div>
        <label className="block text-[12px] text-muted">Entité de rattachement
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] text-fg outline-none">
            <option value="">Aucune</option>
            {units?.map((u) => <option key={u.id} value={u.id}>{" ".repeat(u.depth * 2)}{u.name}</option>)}
          </select>
        </label>
        <div className="flex gap-1.5">{COLORS.map((c) => <button key={c} aria-label={`Couleur ${c}`} onClick={() => setColor(c)} className={cn("size-6 rounded-full ring-offset-2 ring-offset-panel", color === c && "ring-2 ring-fg")} style={{ background: c }} />)}</div>
      </div>
    </Dialog>
  );
}

export function TeamPage() {
  const { id } = useParams();
  const { data: t, error } = useTeam(id);
  const { data: me } = useMe();
  const { data: people } = useUsers();
  const { data: units } = useUnits();
  const users = useUserMap();
  const shell = useShell();
  const qc = useQueryClient();
  const [settings, setSettings] = useState(false);
  if (error) return <div className="p-8 text-[14px] text-danger">{(error as Error).message}</div>;
  if (!t) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const orgRole = me?.orgs.find((o) => o.id === me.org_id)?.role;
  const manager = t.my_role === "lead" || orgRole === "owner" || orgRole === "admin";
  const refresh = () => { qc.invalidateQueries({ queryKey: ["team", t.id] }); qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["projects"] }); };
  const setMember = (userId: string, role: "lead" | "member" | null) => api.put(`/api/teams/${t.id}/members/${userId}`, { role }).then(refresh, (e) => toast.error(e.message));
  const V = VISIBILITY[t.visibility];
  const candidates = (people ?? []).filter((u) => !u.is_ai && u.org_role !== "guest" && !t.members.some((m) => m.user_id === u.id)).map((u) => u.id);

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-8 sm:px-8">
      <header className="mb-8 flex flex-wrap items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm" style={{ background: t.color }}><Users className="size-7" /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{t.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="flex items-center gap-1"><V.icon className="size-3.5" />{V.label}</span>
            <span>{units?.find((u) => u.id === t.unit_id)?.name ?? "Sans entité"}</span>
            <AvatarStack users={t.members.map((m) => users.get(m.user_id))} size={20} />
          </p>
          {t.description && <p className="mt-2 max-w-2xl text-[13.5px]">{t.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <JoinButton t={t} />
          {manager && <Button onClick={() => setSettings(true)}>Réglages</Button>}
          {manager && <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => shell.setNewProject(true, t.id)}>Projet</Button>}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <h2 className="mb-3 text-[14px] font-semibold">Projets · {t.projects.length}</h2>
          {!t.projects.length ? <div className="rounded-2xl border border-dashed border-line-strong"><Empty title="Aucun projet">Les projets de l'équipe apparaîtront ici.</Empty></div> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {t.projects.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="flex items-center gap-3.5 rounded-2xl border border-line bg-panel p-4 shadow-sm hover:border-line-strong">
                  <div className="relative"><ProgressRing value={p.task_count ? p.done_count / p.task_count : 0} size={44} color={p.color} /><span className="absolute inset-0 flex items-center justify-center"><ProjectIcon icon={p.icon} color={p.color} size={22} /></span></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{p.name}</p>
                    <p className="text-[12px] text-muted"><span className="font-mono">{p.key}</span> · <span style={{ color: STATUS[p.status].color }}>{STATUS[p.status].label}</span>{p.access === "private" && " · privé"}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-5">
          {manager && t.requests.length > 0 && (
            <section className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4">
              <h2 className="mb-2 text-[13px] font-semibold">Demandes d'adhésion</h2>
              {t.requests.map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-1.5 text-[13px]">
                  <Avatar user={users.get(r.user_id)} size={22} /><span className="flex-1">{users.get(r.user_id)?.name}</span>
                  <IconButton size="sm" label="Accepter" onClick={() => api.post(`/api/team-requests/${r.id}`, { approve: true }).then(refresh)}><Check className="size-4 text-success" /></IconButton>
                  <IconButton size="sm" label="Refuser" onClick={() => api.post(`/api/team-requests/${r.id}`, { approve: false }).then(refresh)}><X className="size-4" /></IconButton>
                </div>
              ))}
            </section>
          )}
          <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[13px] font-semibold">Membres · {t.members.length}</h2>
              {manager && candidates.length > 0 && (
                <AssigneePicker memberIds={candidates} value={null} onChange={(uid) => uid && setMember(uid, "member")} align="end">
                  <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" />}>Ajouter</Button>
                </AssigneePicker>
              )}
            </div>
            {t.members.map((m) => {
              const u = users.get(m.user_id);
              return (
                <div key={m.user_id} className="group flex h-10 items-center gap-2.5">
                  <Avatar user={u} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{u?.name}</span>
                  {manager ? (
                    <select aria-label={`Rôle de ${u?.name}`} value={m.role} onChange={(e) => setMember(m.user_id, e.target.value === "remove" ? null : (e.target.value as "lead" | "member"))}
                      className="rounded-md bg-transparent px-1 py-0.5 text-[12px] text-muted outline-none hover:bg-hover">
                      <option value="lead">Responsable</option><option value="member">Membre</option><option value="remove">Retirer</option>
                    </select>
                  ) : <span className="text-[12px] text-faint">{m.role === "lead" ? "Responsable" : "Membre"}</span>}
                </div>
              );
            })}
          </section>
        </aside>
      </div>
      {settings && <TeamDialog open={settings} onOpenChange={setSettings} team={t} />}
    </div>
  );
}
