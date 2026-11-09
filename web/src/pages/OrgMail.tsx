import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AtSign, Building2, Check, CircleAlert, Copy, Mail, Network, Pencil, Send, ShieldCheck, Users, X } from "lucide-react";
import { Button, Chip, Spinner, cn } from "@/components/ui";
import { useMailConfig, useMailLog, useServiceAddresses } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { MailConfig, ServiceAddress, SmtpSecurity } from "@/lib/types";

const SECURITY: Record<SmtpSecurity, { label: string; port: number; hint: string }> = {
  starttls: { label: "STARTTLS", port: 587, hint: "Recommandé : connexion chiffrée après l'ouverture (port 587)." },
  tls: { label: "TLS implicite", port: 465, hint: "Connexion chiffrée dès l'ouverture (port 465)." },
  none: { label: "Aucune", port: 25, hint: "Sans chiffrement : à réserver à un relais interne de confiance." },
};
const field = "h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none focus:border-line-strong";

/** Onglet « Messagerie » de l'organisation : serveur SMTP, domaine, adresses de service par niveau. */
export function OrgMail({ orgName }: { orgName: string }) {
  const { data: cfg, isLoading } = useMailConfig();
  if (isLoading) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[420px_minmax(0,1fr)]">
      <SmtpForm cfg={cfg ?? null} orgName={orgName} />
      <div className="min-w-0 space-y-5">
        {cfg ? <Addresses domain={cfg.domain} /> : (
          <section className="rounded-2xl border border-dashed border-line-strong p-8 text-center">
            <AtSign className="mx-auto size-6 text-faint" />
            <h3 className="mt-2 text-[14.5px] font-semibold">Un domaine, une adresse par niveau</h3>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
              Renseignez le domaine et le serveur SMTP de l'organisation. Cadence attribue alors une adresse de service à l'organisation (contact@), à chaque entité et à chaque équipe.
              Les notifications partent de l'adresse de l'équipe concernée.
            </p>
          </section>
        )}
        {cfg && <SendLog />}
      </div>
    </div>
  );
}

function SmtpForm({ cfg, orgName }: { cfg: MailConfig | null; orgName: string }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => init(cfg, orgName));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  useEffect(() => setF(init(cfg, orgName)), [cfg, orgName]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setResult(null); };
  const valid = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f.domain.trim()) && f.host.trim() && f.port > 0;

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/api/org/mail", {
        domain: f.domain.trim(), from_name: f.from_name.trim(), notifications: f.notifications,
        smtp: { host: f.host.trim(), port: Number(f.port), security: f.security, username: f.username.trim(), password: f.password },
      });
      setF((x) => ({ ...x, password: "" }));
      qc.invalidateQueries({ queryKey: ["mail"] });
      toast.success("Messagerie enregistrée");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true); setResult(null);
    try { const r = await api.post<{ ok: boolean; error?: string }>("/api/org/mail/test"); setResult(r); qc.invalidateQueries({ queryKey: ["mail", "log"] }); }
    catch (e) { setResult({ ok: false, error: (e as Error).message }); }
    finally { setTesting(false); }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-line bg-panel p-5 shadow-sm lg:sticky lg:top-4 lg:self-start" aria-label="Serveur d'envoi">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Mail className="size-4" />Serveur d'envoi</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">SMTP propre à {orgName}. Le mot de passe est chiffré et n'est jamais réaffiché.</p>
        </div>
        {cfg && <Chip tone="success" icon={<ShieldCheck className="size-3" />}>Configuré</Chip>}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-[12px] text-muted sm:col-span-2">Domaine des adresses
          <div className="mt-1 flex items-center rounded-lg border border-line bg-bg/60 focus-within:border-line-strong">
            <span className="pl-2.5 text-[13.5px] text-faint">@</span>
            <input value={f.domain} onChange={(e) => set("domain", e.target.value.toLowerCase())} placeholder="mon-entreprise.fr" className="h-9 w-full bg-transparent px-1 text-[13.5px] text-fg outline-none" />
          </div>
        </label>
        <label className="text-[12px] text-muted sm:col-span-2">Nom d'expéditeur
          <input value={f.from_name} onChange={(e) => set("from_name", e.target.value)} placeholder={orgName} className={cn(field, "mt-1 text-fg")} />
        </label>
        <label className="text-[12px] text-muted sm:col-span-2">Hôte SMTP
          <input value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.mon-entreprise.fr" autoComplete="off" className={cn(field, "mt-1 font-mono text-[13px] text-fg")} />
        </label>
        <label className="text-[12px] text-muted">Sécurité
          <select value={f.security} onChange={(e) => { const s = e.target.value as SmtpSecurity; setF((x) => ({ ...x, security: s, port: Object.values(SECURITY).some((v) => v.port === x.port) ? SECURITY[s].port : x.port })); }} className={cn(field, "mt-1 text-fg")}>
            {Object.entries(SECURITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="text-[12px] text-muted">Port
          <input type="number" min={1} max={65535} value={f.port} onChange={(e) => set("port", Number(e.target.value))} className={cn(field, "mt-1 tabular text-fg")} />
        </label>
        <p className={cn("-mt-1 text-[11.5px] sm:col-span-2", f.security === "none" ? "text-warning" : "text-faint")}>{SECURITY[f.security].hint}</p>
        <label className="text-[12px] text-muted">Identifiant
          <input value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" className={cn(field, "mt-1 text-fg")} />
        </label>
        <label className="text-[12px] text-muted">Mot de passe
          <input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password"
            placeholder={cfg?.smtp.password_set ? "•••••••• (inchangé)" : ""} className={cn(field, "mt-1 text-fg")} />
        </label>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3">
        <input type="checkbox" checked={f.notifications} onChange={(e) => set("notifications", e.target.checked)} className="mt-0.5 size-4 accent-[var(--fg)]" />
        <span className="text-[13px]"><span className="font-medium">Notifications par e-mail</span>
          <span className="block text-[12px] text-muted">Assignations, mentions, commentaires et validations sont aussi envoyés par e-mail, depuis l'adresse de l'équipe du projet.</span></span>
      </label>

      {result && (
        <p role="status" className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]", result.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
          {result.ok ? <Check className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {result.ok ? "E-mail de test envoyé : vérifiez votre boîte de réception." : result.error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {cfg && <Button icon={<Send className="size-3.5" />} loading={testing} onClick={test}>Envoyer un test</Button>}
        <Button variant="primary" loading={saving} disabled={!valid} onClick={save}>Enregistrer</Button>
      </div>
    </section>
  );
}

function init(cfg: MailConfig | null, orgName: string) {
  return {
    domain: cfg?.domain ?? "", from_name: cfg?.from_name ?? orgName, notifications: cfg?.notifications ?? true,
    host: cfg?.smtp.host ?? "", port: cfg?.smtp.port ?? 587, security: cfg?.smtp.security ?? ("starttls" as SmtpSecurity),
    username: cfg?.smtp.username ?? "", password: "",
  };
}

const LEVEL_ICON = { org: Building2, unit: Network, team: Users };

function Addresses({ domain }: { domain: string }) {
  const { data, isLoading } = useServiceAddresses();
  const groups: [string, ServiceAddress[]][] = [
    ["Organisation", (data ?? []).filter((a) => a.target_type === "org")],
    ["Entités", (data ?? []).filter((a) => a.target_type === "unit")],
    ["Équipes", (data ?? []).filter((a) => a.target_type === "team")],
  ];
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm" aria-label="Adresses de service">
      <header className="border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold">Adresses de service</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">Une adresse par niveau, toutes sur <span className="font-mono text-fg">@{domain}</span>. Créez-les ensuite chez votre hébergeur de messagerie (boîte ou alias) pour recevoir les réponses.</p>
      </header>
      {isLoading ? <div className="p-5"><Spinner /></div> : groups.map(([title, list]) => !!list.length && (
        <div key={title}>
          <h3 className="bg-hover/60 px-5 py-1.5 text-[11.5px] font-medium uppercase tracking-wider text-faint">{title}</h3>
          {list.map((a) => <AddressRow key={a.id} a={a} domain={domain} />)}
        </div>
      ))}
    </section>
  );
}

function AddressRow({ a, domain }: { a: ServiceAddress; domain: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(a.local_part);
  const Icon = LEVEL_ICON[a.target_type];
  const save = () => api.patch(`/api/org/mail/addresses/${a.id}`, { local_part: local }).then(() => {
    setEditing(false); qc.invalidateQueries({ queryKey: ["mail", "addresses"] }); toast.success("Adresse mise à jour");
  }, (e) => toast.error(e.message));
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-1 basis-[180px] items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-hover text-muted"><Icon className="size-3.5" /></span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium">{a.name}</span>
          <span className="block truncate text-[11.5px] text-faint">{a.kind}{a.parent_name ? ` · ${a.parent_name}` : ""}</span>
        </span>
      </span>
      {editing ? (
        <span className="flex items-center gap-1.5">
          <span className="flex items-center rounded-lg border border-line-strong bg-bg/60">
            <input autoFocus value={local} onChange={(e) => setLocal(e.target.value.toLowerCase())} aria-label={`Adresse de ${a.name}`}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setEditing(false); setLocal(a.local_part); } }}
              className="h-8 w-[150px] bg-transparent px-2 text-right font-mono text-[12.5px] outline-none" />
            <span className="pr-2 font-mono text-[12.5px] text-faint">@{domain}</span>
          </span>
          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={save} aria-label="Enregistrer l'adresse" />
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => { setEditing(false); setLocal(a.local_part); }} aria-label="Annuler" />
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <span className="font-mono text-[12.5px]">{a.address}</span>
          <button aria-label={`Copier ${a.address}`} title="Copier" onClick={() => navigator.clipboard?.writeText(a.address).then(() => toast.success("Adresse copiée"))} className="rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg"><Copy className="size-3.5" /></button>
          <button aria-label={`Modifier l'adresse de ${a.name}`} title="Modifier" onClick={() => setEditing(true)} className="rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg"><Pencil className="size-3.5" /></button>
        </span>
      )}
    </div>
  );
}

function SendLog() {
  const { data } = useMailLog();
  if (!data?.length) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm" aria-label="Derniers envois">
      <h2 className="border-b border-line px-5 py-3 text-[14px] font-semibold">Derniers envois</h2>
      <ul>
        {data.slice(0, 12).map((l) => (
          <li key={l.id} className="flex items-start gap-3 border-b border-line px-5 py-2.5 text-[12.5px] last:border-b-0">
            <span className={cn("mt-1 size-2 shrink-0 rounded-full", l.status === "sent" ? "bg-success" : "bg-danger")} title={l.status === "sent" ? "Envoyé" : "Échec"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{l.subject}</span>
              <span className="block truncate text-faint"><span className="font-mono">{l.from_address}</span> → <span className="font-mono">{l.to_address}</span></span>
              {l.error && <span className="block text-danger">{l.error}</span>}
            </span>
            <time className="shrink-0 text-faint tabular" dateTime={l.created_at}>{new Date(l.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
