import { useState } from "react";
import { Navigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button, Chip, Dialog, Menu, MenuContent, MenuItem, MenuTrigger, Spinner, cn } from "@/components/ui";
import { useMe } from "@/lib/hooks";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { AdminOrg, AdminUser, InviteResult, SecurityEvent } from "@/lib/types";
import { LinkResult } from "./OrgAccess";

const STATUS: Record<
  AdminUser["status"],
  { label: string; tone: "success" | "warning" | "danger" | "muted" | "info" }
> = {
  active: { label: "Actif", tone: "success" },
  invited: { label: "Invité", tone: "info" },
  pending: { label: "À valider", tone: "warning" },
  suspended: { label: "Suspendu", tone: "danger" },
  rejected: { label: "Refusé", tone: "muted" },
};
const failure = (e: unknown) => toast.error((e as Error).message);
const EVENT: Record<string, string> = {
  "login.success": "Connexion réussie",
  "login.failed": "Échec de connexion",
  "account.locked": "Compte verrouillé",
  "account.activated": "Compte activé",
  "account.invited": "Invitation envoyée",
  "account.suspended": "Compte suspendu",
  "account.reactivated": "Compte réactivé",
  "access.requested": "Demande d'accès",
  "access.approved": "Demande validée",
  "access.rejected": "Demande refusée",
  "password.changed": "Mot de passe changé",
  "password.reset": "Mot de passe réinitialisé",
  "password.forgot": "Mot de passe oublié",
  "password.reset_requested": "Réinitialisation demandée par un administrateur",
  "mfa.enabled": "Double authentification activée",
  "mfa.disabled": "Double authentification désactivée",
  "mfa.failed": "Code de vérification erroné",
  "mfa.recovery_used": "Code de secours utilisé",
  "sessions.revoked": "Sessions fermées",
  "platform.granted": "Rôle d'administrateur système accordé",
  "platform.revoked": "Rôle d'administrateur système retiré",
  "settings.registration": "Mode d'inscription modifié",
  "profile.created": "Profil créé",
  "profile.updated": "Profil modifié",
  "profile.deleted": "Profil supprimé",
  "member.profile": "Profil attribué",
  "member.permissions": "Droits individuels modifiés",
  "invitation.cancelled": "Invitation annulée",
};

/** Console de l'administrateur système : tous les comptes, inscriptions et journal de sécurité. */
export function AdminPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<"users" | "settings" | "events">("users");
  if (me && !me.platform_role) return <Navigate to="/" replace />;
  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-8">
      <p className="flex items-center gap-1.5 text-[13px] text-muted">
        <ShieldCheck className="size-4" />
        Plateforme
      </p>
      <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.02em]">Administration système</h1>
      {me && !me.mfa_enabled && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
          <AlertTriangle className="size-4 shrink-0" />
          Ce compte contrôle toute la plateforme : activez la double authentification dans « Sécurité du compte ».
        </p>
      )}
      <div className="mb-5 mt-5 flex gap-1 border-b border-line">
        {(
          [
            ["users", "Comptes"],
            ["settings", "Inscriptions"],
            ["events", "Journal de sécurité"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              "-mb-px border-b-2 px-2.5 pb-2.5 text-[13.5px]",
              tab === k ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "users" ? <Users meId={me?.id} /> : tab === "settings" ? <Settings /> : <Events />}
    </div>
  );
}

function Users({ meId }: { meId?: string }) {
  const qc = useQueryClient();
  const { data: users } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => api.get<AdminUser[]>("/api/admin/users"),
  });
  const [approving, setApproving] = useState<AdminUser | null>(null);
  const [link, setLink] = useState<InviteResult | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });
  const act = (id: string, action: string, ok: string, body: unknown = {}) =>
    api.post(`/api/admin/users/${id}/${action}`, body).then(() => {
      refresh();
      toast.success(ok);
    }, failure);
  const reset = (u: AdminUser, clear_mfa: boolean) =>
    api.post<InviteResult>(`/api/admin/users/${u.id}/reset`, { clear_mfa }).then((r) => {
      if (r.link) setLink(r);
      else toast.success("Lien envoyé par e-mail");
      refresh();
    }, failure);
  const setRole = (u: AdminUser, on: boolean) =>
    api.put(`/api/admin/users/${u.id}/platform-role`, { super_admin: on }).then(() => {
      refresh();
      toast.success("Rôle modifié");
    }, failure);
  if (!users) return <Spinner />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
      {link && <LinkResult result={link} onClose={() => setLink(null)} />}
      {approving && (
        <Approve
          user={approving}
          onClose={() => setApproving(null)}
          onDone={(r) => {
            setApproving(null);
            refresh();
            if (r.link) setLink(r);
            else toast.success("Invitation envoyée");
          }}
        />
      )}
      <table className="w-full min-w-[820px] text-left text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">Compte</th>
            <th className="px-2 font-medium">État</th>
            <th className="px-2 font-medium">Organisations</th>
            <th className="px-2 font-medium">Sécurité</th>
            <th className="px-2 font-medium">Dernière connexion</th>
            <th className="px-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-line last:border-b-0">
              <td className="px-4 py-2.5">
                <span className="block font-medium">
                  {u.name}
                  {u.platform_role && <span className="ml-1.5 text-[11px] text-ai-fg">Admin système</span>}
                </span>
                <span className="block text-[12px] text-faint">{u.email}</span>
                {u.access_request_note && (
                  <span className="block text-[12px] text-muted">« {u.access_request_note} »</span>
                )}
              </td>
              <td className="px-2">
                <Chip tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Chip>
              </td>
              <td className="max-w-[200px] truncate px-2 text-[12.5px] text-muted">
                {u.orgs.map((o) => o.org_name).join(", ") || "—"}
              </td>
              <td className="px-2 text-[12.5px] text-muted">
                {u.totp_enabled ? "2FA active" : "Sans 2FA"} · {u.active_sessions} session(s)
              </td>
              <td className="px-2 text-[12.5px] text-muted">{u.last_login_at ? ago(u.last_login_at) : "Jamais"}</td>
              <td className="px-2 py-2 text-right">
                {u.status === "pending" ? (
                  <span className="flex justify-end gap-1">
                    <Button size="sm" variant="primary" onClick={() => setApproving(u)}>
                      Valider
                    </Button>
                    <Button size="sm" onClick={() => act(u.id, "reject", "Demande refusée")}>
                      Refuser
                    </Button>
                  </span>
                ) : (
                  u.id !== meId && (
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="sm">Actions</Button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        {u.status === "suspended" && (
                          <MenuItem onSelect={() => act(u.id, "reactivate", "Compte réactivé")}>Réactiver</MenuItem>
                        )}
                        {u.status === "active" && (
                          <>
                            <MenuItem onSelect={() => reset(u, false)}>Envoyer un lien de mot de passe</MenuItem>
                            {u.totp_enabled && (
                              <MenuItem onSelect={() => reset(u, true)}>Réinitialiser aussi la 2FA</MenuItem>
                            )}
                            <MenuItem onSelect={() => act(u.id, "revoke-sessions", "Sessions fermées")}>
                              Fermer ses sessions
                            </MenuItem>
                            <MenuItem onSelect={() => setRole(u, !u.platform_role)}>
                              {u.platform_role ? "Retirer le rôle système" : "Nommer administrateur système"}
                            </MenuItem>
                            <MenuItem danger onSelect={() => act(u.id, "suspend", "Compte suspendu")}>
                              Suspendre
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Approve({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (r: InviteResult) => void;
}) {
  const { data: orgs } = useQuery({ queryKey: ["admin-orgs"], queryFn: () => api.get<AdminOrg[]>("/api/admin/orgs") });
  const [orgId, setOrgId] = useState("");
  const [profileId, setProfileId] = useState("");
  const org = orgs?.find((o) => o.id === orgId) ?? orgs?.[0];
  const profiles = org?.profiles.filter((p) => p.base_role !== "owner") ?? [];
  const profile =
    profiles.find((p) => p.id === profileId) ?? profiles.find((p) => p.base_role === "member") ?? profiles[0];
  const sel = "mt-1 h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none";
  const submit = () =>
    api
      .post<InviteResult>(`/api/admin/users/${user.id}/approve`, { org_id: org!.id, profile_id: profile!.id })
      .then(onDone, failure);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      width={460}
      title={`Valider ${user.name}`}
      description="La personne recevra une invitation pour choisir son mot de passe."
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={!org || !profile} onClick={submit}>
            Valider et inviter
          </Button>
        </>
      }
    >
      {!orgs ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <label className="block text-[12.5px] text-muted">
            Organisation
            <select
              value={org?.id ?? ""}
              onChange={(e) => {
                setOrgId(e.target.value);
                setProfileId("");
              }}
              className={sel}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12.5px] text-muted">
            Profil
            <select value={profile?.id ?? ""} onChange={(e) => setProfileId(e.target.value)} className={sel}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </Dialog>
  );
}

function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.get<{ registration: "invite" | "approval" }>("/api/admin/settings"),
  });
  const set = (registration: "invite" | "approval") =>
    api.patch("/api/admin/settings", { registration }).then(() => {
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      toast.success("Réglage enregistré");
    }, failure);
  if (!data) return <Spinner />;
  const options = [
    {
      v: "invite" as const,
      title: "Sur invitation uniquement (recommandé)",
      text: "Seuls les administrateurs créent des comptes. La personne reçoit un lien et choisit son mot de passe.",
    },
    {
      v: "approval" as const,
      title: "Demande d'accès avec validation",
      text: "La page de connexion propose de demander un accès. Rien n'est ouvert avant votre validation, qui déclenche une invitation.",
    },
  ];
  return (
    <div className="max-w-2xl space-y-2">
      <NewOrganization />
      <h3 className="pt-4 text-[14px] font-semibold">Création des comptes</h3>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => set(o.v)}
          className={cn(
            "w-full rounded-xl border p-4 text-left",
            data.registration === o.v ? "border-fg bg-hover" : "border-line hover:border-line-strong",
          )}
        >
          <p className="text-[14px] font-medium">{o.title}</p>
          <p className="mt-0.5 text-[13px] text-muted">{o.text}</p>
        </button>
      ))}
    </div>
  );
}

function NewOrganization() {
  const [name, setName] = useState("");
  const create = () => api.post("/api/orgs", { name }).then(() => window.location.assign("/org"), failure);
  return (
    <section className="rounded-xl border border-line p-4">
      <h3 className="text-[14px] font-semibold">Nouvelle organisation</h3>
      <p className="mt-0.5 text-[13px] text-muted">Vous en serez propriétaire et pourrez y inviter ses membres.</p>
      <div className="mt-2 flex gap-2">
        <input
          aria-label="Nom de l'organisation"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom de l'organisation"
          className="h-9 flex-1 rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none"
        />
        <Button variant="primary" className="h-9" disabled={!name.trim()} onClick={create}>
          Créer
        </Button>
      </div>
    </section>
  );
}

function Events() {
  const { data } = useQuery({
    queryKey: ["admin-events"],
    queryFn: () => api.get<SecurityEvent[]>("/api/admin/events"),
  });
  if (!data) return <Spinner />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">Événement</th>
            <th className="px-2 font-medium">Compte</th>
            <th className="px-2 font-medium">Par</th>
            <th className="px-2 font-medium">Adresse</th>
            <th className="px-2 font-medium">Quand</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e) => (
            <tr key={e.id} className="border-b border-line last:border-b-0">
              <td className="px-4 py-2">{EVENT[e.kind] ?? e.kind}</td>
              <td className="px-2 text-muted">{e.user_name ?? String(e.data.email ?? "—")}</td>
              <td className="px-2 text-muted">{e.actor_name ?? "—"}</td>
              <td className="px-2 font-mono text-[12px] text-faint">{e.ip ?? "—"}</td>
              <td className="px-2 text-muted">{ago(e.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
