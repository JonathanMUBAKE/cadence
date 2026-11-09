import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Plus, Trash2, UserPlus } from "lucide-react";
import { Button, Chip, ConfirmDialog, Dialog, Spinner, cn } from "@/components/ui";
import { api } from "@/lib/api";
import type { AccessProfile, BaseRole, Invitation, InviteResult, MemberAccess, OrgUser, PermissionGroup } from "@/lib/types";

const BASE_ROLES: { value: BaseRole; label: string; hint: string }[] = [
  { value: "guest", label: "Invité", hint: "uniquement les projets partagés avec lui" },
  { value: "member", label: "Membre", hint: "ses équipes et les projets publics" },
  { value: "admin", label: "Administrateur", hint: "tous les projets de l'organisation" },
];
const failure = (e: unknown) => toast.error((e as Error).message);
const field = "h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none focus:border-line-strong";
export const useProfiles = (enabled: boolean) => useQuery({ queryKey: ["profiles"], queryFn: () => api.get<AccessProfile[]>("/api/org/profiles"), enabled, retry: false }).data;
const useCatalog = () => useQuery({ queryKey: ["permissions"], queryFn: () => api.get<PermissionGroup[]>("/api/org/permissions"), staleTime: Infinity }).data;

// ------------------------------------------------------------------ profils à cocher
export function ProfilesPanel() {
  const profiles = useProfiles(true);
  const catalog = useCatalog();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = profiles?.find((p) => p.id === selected) ?? profiles?.[0];
  if (!profiles || !catalog) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div>
        <ul className="space-y-1">
          {profiles.map((p) => (
            <li key={p.id}><button onClick={() => { setSelected(p.id); setCreating(false); }} className={cn("w-full rounded-lg border px-3 py-2 text-left", !creating && p.id === current?.id ? "border-line-strong bg-active" : "border-transparent hover:bg-hover")}>
              <span className="block text-[13.5px] font-medium">{p.name}</span>
              <span className="block text-[12px] text-faint">{p.member_count} personne(s){p.is_system ? " · système" : ""}</span>
            </button></li>
          ))}
        </ul>
        <Button className="mt-2 w-full" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>Nouveau profil</Button>
      </div>
      {creating
        ? <ProfileForm key="new" catalog={catalog} onDone={(id) => { setSelected(id); setCreating(false); }} />
        : current && <ProfileForm key={current.id} profile={current} catalog={catalog} onDone={() => undefined} onDeleted={() => setSelected(null)} />}
    </div>
  );
}

function ProfileForm({ profile, catalog, onDone, onDeleted }: { profile?: AccessProfile; catalog: PermissionGroup[]; onDone: (id: string) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [baseRole, setBaseRole] = useState<BaseRole>(profile?.base_role ?? "member");
  const [perms, setPerms] = useState(new Set(profile?.permissions ?? []));
  const [confirming, setConfirming] = useState(false);
  const locked = profile?.base_role === "owner";
  const refresh = () => { qc.invalidateQueries({ queryKey: ["profiles"] }); qc.invalidateQueries({ queryKey: ["me"] }); qc.invalidateQueries({ queryKey: ["users"] }); };
  const toggle = (k: string) => { if (locked) return; const n = new Set(perms); if (n.has(k)) n.delete(k); else n.add(k); setPerms(n); };
  const toggleGroup = (g: PermissionGroup, on: boolean) => { if (locked) return; const n = new Set(perms); for (const i of g.items) { if (on) n.add(i.key); else n.delete(i.key); } setPerms(n); };
  const save = () => {
    const body = { name, description, base_role: baseRole, permissions: [...perms] };
    (profile ? api.patch<AccessProfile>(`/api/org/profiles/${profile.id}`, body) : api.post<AccessProfile>("/api/org/profiles", body)).then((p) => { refresh(); toast.success("Profil enregistré"); onDone(p.id); }, failure);
  };
  const remove = () => api.del(`/api/org/profiles/${profile!.id}`).then(() => { refresh(); toast.success("Profil supprimé"); onDeleted?.(); }, failure);
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
      {locked && <p className="mb-3 rounded-lg bg-hover px-3 py-2 text-[12.5px] text-muted">Le profil Propriétaire a tous les droits et ne peut pas être modifié : une organisation ne doit jamais perdre le contrôle d'elle-même.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-[12.5px] text-muted">Nom du profil<input value={name} disabled={profile?.is_system} maxLength={80} onChange={(e) => setName(e.target.value)} className={cn(field, "mt-1 disabled:opacity-60")} /></label>
        <label className="text-[12.5px] text-muted">Niveau d'accès aux projets
          <select value={baseRole} disabled={profile?.is_system} onChange={(e) => setBaseRole(e.target.value as BaseRole)} className={cn(field, "mt-1 disabled:opacity-60")}>
            {profile?.base_role === "owner" && <option value="owner">Propriétaire</option>}
            {BASE_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label} : {r.hint}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-[12.5px] text-muted">Description<input value={description} disabled={locked} maxLength={300} onChange={(e) => setDescription(e.target.value)} className={cn(field, "mt-1 disabled:opacity-60")} /></label>
      <div className="mt-5 space-y-5">
        {catalog.map((g) => {
          const all = g.items.every((i) => perms.has(i.key));
          return (
            <fieldset key={g.group}>
              <legend className="flex w-full items-center gap-2 border-b border-line pb-1.5 text-[13px] font-semibold">{g.group}{!locked && <button type="button" onClick={() => toggleGroup(g, !all)} className="ml-auto text-[12px] font-normal text-muted hover:text-fg">{all ? "Tout décocher" : "Tout cocher"}</button>}</legend>
              <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {g.items.map((i) => (
                  <label key={i.key} className={cn("flex items-center gap-2.5 rounded-md px-1 py-1 text-[13px]", !locked && "cursor-pointer hover:bg-hover")}>
                    <input type="checkbox" checked={perms.has(i.key)} disabled={locked} onChange={() => toggle(i.key)} className="size-4 accent-[var(--ai)]" />{i.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      {!locked && (
        <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
          {profile && !profile.is_system && <><Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirming(true)}>Supprimer</Button><ConfirmDialog open={confirming} onOpenChange={setConfirming} title={`Supprimer « ${profile.name} » ?`} description="Un profil encore attribué ne peut pas être supprimé." confirmLabel="Supprimer le profil" onConfirm={remove} /></>}
          <Button variant="primary" className="ml-auto" disabled={!name.trim()} icon={<Check className="size-3.5" />} onClick={save}>{profile ? "Enregistrer" : "Créer le profil"}</Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ exceptions individuelles
export function MemberAccessButton({ user }: { user: OrgUser }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Ajuster</Button>{open && <MemberAccessDialog user={user} onClose={() => setOpen(false)} />}</>;
}

function MemberAccessDialog({ user, onClose }: { user: OrgUser; onClose: () => void }) {
  const catalog = useCatalog();
  const qc = useQueryClient();
  const key = useMemo(() => ["member-access", user.id], [user.id]);
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<MemberAccess>(`/api/org/members/${user.id}/access`) });
  const [changes, setChanges] = useState<Record<string, boolean | null>>({});
  useEffect(() => setChanges({}), [data]);
  const state = (k: string): "profile" | "allow" | "deny" => { const v = k in changes ? changes[k] : data?.overrides[k]; return v === true ? "allow" : v === false ? "deny" : "profile"; };
  const set = (k: string, v: "profile" | "allow" | "deny") => setChanges({ ...changes, [k]: v === "profile" ? null : v === "allow" });
  const save = () => api.put(`/api/org/members/${user.id}/permissions`, { overrides: changes }).then(() => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ["users"] }); toast.success("Droits mis à jour"); onClose(); }, failure);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} width={640} title={`Droits de ${user.name}`} description="Une exception s'applique à cette personne seulement et l'emporte sur son profil."
      footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" disabled={!Object.keys(changes).length} onClick={save}>Enregistrer</Button></>}>
      {!data || !catalog ? <Spinner /> : data.role === "owner" ? <p className="text-[13.5px] text-muted">Un propriétaire a toujours tous les droits.</p> : (
        <div className="space-y-4">
          {catalog.map((g) => (
            <div key={g.group}>
              <p className="mb-1 text-[12px] font-medium uppercase tracking-wider text-faint">{g.group}</p>
              {g.items.map((i) => {
                const current = state(i.key);
                const fromProfile = data.profile_permissions.includes(i.key);
                return (
                  <div key={i.key} className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0">
                    <span className="min-w-0 flex-1 text-[13px]">{i.label}</span>
                    <div role="radiogroup" aria-label={i.label} className="flex overflow-hidden rounded-md border border-line text-[12px]">
                      {([["profile", `Profil (${fromProfile ? "oui" : "non"})`], ["allow", "Autoriser"], ["deny", "Refuser"]] as const).map(([v, l]) => (
                        <button key={v} role="radio" aria-checked={current === v} onClick={() => set(i.key, v)} className={cn("px-2 py-1", current === v ? (v === "deny" ? "bg-danger-soft font-medium text-danger" : v === "allow" ? "bg-success-soft font-medium text-success" : "bg-active font-medium") : "text-muted hover:bg-hover")}>{l}</button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ invitations
export function LinkResult({ result, onClose }: { result: InviteResult; onClose: () => void }) {
  const url = result.link ? new URL(result.link, window.location.origin).href : "";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} width={560} title="Aucun e-mail n'a pu être envoyé" description="La messagerie n'est pas configurée. Transmettez ce lien personnel à la personne concernée, par un canal sûr. Il ne sera plus affiché."
      footer={<Button variant="primary" onClick={onClose}>Fermer</Button>}>
      <div className="flex items-center gap-2"><input readOnly value={url} aria-label="Lien personnel" className={cn(field, "font-mono text-[12px]")} /><Button icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(url).then(() => toast.success("Lien copié"), failure)}>Copier</Button></div>
    </Dialog>
  );
}

export function InvitationsPanel() {
  const qc = useQueryClient();
  const profiles = useProfiles(true);
  const { data: invitations } = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<Invitation[]>("/api/org/invitations") });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [link, setLink] = useState<InviteResult | null>(null);
  const options = (profiles ?? []).filter((p) => p.base_role !== "owner");
  const profileId = options.some((p) => p.id === profile) ? profile : options.find((p) => p.base_role === "member")?.id ?? options[0]?.id ?? "";
  const refresh = () => { qc.invalidateQueries({ queryKey: ["invitations"] }); qc.invalidateQueries({ queryKey: ["users"] }); };
  const report = (r: InviteResult) => { refresh(); if (r.link) setLink(r); else if (r.sent) toast.success("Invitation envoyée"); else toast.error("L'e-mail n'a pas pu partir : l'invitation reste en attente, renvoyez-la plus tard"); };
  const invite = () => api.post<InviteResult>("/api/org/invitations", { email, name, profile_id: profileId }).then((r) => { setEmail(""); setName(""); report(r); }, failure);
  return (
    <section className="mt-5 rounded-2xl border border-line bg-panel p-5 shadow-sm">
      {link && <LinkResult result={link} onClose={() => setLink(null)} />}
      <h3 className="flex items-center gap-2 text-[14px] font-semibold"><UserPlus className="size-4 text-muted" />Inviter une personne</h3>
      <p className="mt-0.5 text-[12.5px] text-muted">Elle reçoit un e-mail et rejoint l'organisation une fois l'invitation acceptée, sous 72 heures.</p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_180px_auto]">
        <input aria-label="Nom complet" placeholder="Nom complet" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        <input aria-label="Adresse e-mail" type="email" placeholder="Adresse e-mail" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        <select aria-label="Profil" value={profileId} onChange={(e) => setProfile(e.target.value)} className={field}>{options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <Button variant="primary" className="h-9" disabled={!email.includes("@") || !name.trim() || !profileId} onClick={invite}>Inviter</Button>
      </div>
      {!!invitations?.length && (
        <ul className="mt-4 divide-y divide-line">
          {invitations.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{i.name}</span><span className="block text-[12px] text-faint">{i.email}</span></span>
              {i.profile_name && <Chip>{i.profile_name}</Chip>}
              <Button size="sm" onClick={() => api.post<InviteResult>(`/api/org/invitations/${i.id}/resend`).then(report, failure)}>Renvoyer</Button>
              <Button size="sm" variant="danger" onClick={() => api.del(`/api/org/invitations/${i.id}`).then(refresh, failure)}>Annuler</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
