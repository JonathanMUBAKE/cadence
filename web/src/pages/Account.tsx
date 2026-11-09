import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Laptop, ShieldCheck } from "lucide-react";
import { Button, Chip, Spinner } from "@/components/ui";
import { useMe } from "@/lib/hooks";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { SessionInfo } from "@/lib/types";
import { PASSWORD_HINT } from "./AccountLinks";

const field = "mt-1 h-9 w-full max-w-sm rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none focus:border-line-strong";
const failure = (e: unknown) => toast.error((e as Error).message);

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-line bg-panel p-5 shadow-sm"><h2 className="mb-3 flex items-center gap-2 text-[14.5px] font-semibold">{icon}{title}</h2>{children}</section>;
}

/** Sécurité du compte : mot de passe, double authentification, appareils connectés. */
export function AccountPage() {
  return (
    <div className="mx-auto max-w-[760px] space-y-5 px-4 pb-16 pt-8 sm:px-8">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Sécurité du compte</h1>
      <PasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api.post("/api/auth/password", { current, password }); setCurrent(""); setPassword(""); qc.invalidateQueries({ queryKey: ["sessions"] }); toast.success("Mot de passe modifié : vos autres appareils ont été déconnectés"); }
    catch (err) { failure(err); } finally { setBusy(false); }
  };
  return (
    <Card icon={<KeyRound className="size-4 text-muted" />} title="Mot de passe">
      <form onSubmit={submit}>
        <label className="block text-[12.5px] text-muted">Mot de passe actuel<input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={field} /></label>
        <label className="mt-2 block text-[12.5px] text-muted">Nouveau mot de passe<input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className={field} /></label>
        <p className="mt-1 text-[12px] text-faint">{PASSWORD_HINT}</p>
        <Button type="submit" variant="primary" className="mt-3" loading={busy}>Changer le mot de passe</Button>
      </form>
    </Card>
  );
}

function MfaCard() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["me"] });
  const start = () => api.post<{ secret: string; qr: string }>("/api/auth/mfa/setup").then(setSetup, failure);
  const confirm = () => api.post<{ recovery_codes: string[] }>("/api/auth/mfa/confirm", { code }).then((r) => { setRecovery(r.recovery_codes); setSetup(null); setCode(""); refresh(); }, failure);
  const disable = () => api.post("/api/auth/mfa/disable", { password, code }).then(() => { setPassword(""); setCode(""); refresh(); toast.success("Double authentification désactivée"); }, failure);
  return (
    <Card icon={<ShieldCheck className="size-4 text-muted" />} title="Double authentification">
      {recovery ? (
        <div>
          <p className="text-[13.5px] font-medium">Conservez ces codes de secours en lieu sûr.</p>
          <p className="mt-0.5 text-[12.5px] text-muted">Chacun sert une seule fois si vous perdez votre téléphone. Ils ne seront plus jamais affichés.</p>
          <ul className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-hover p-3 font-mono text-[13px]">{recovery.map((c) => <li key={c}>{c}</li>)}</ul>
          <Button className="mt-3" onClick={() => setRecovery(null)}>J'ai conservé ces codes</Button>
        </div>
      ) : me?.mfa_enabled ? (
        <div>
          <Chip tone="success">Activée</Chip>
          <label className="mt-3 block text-[12.5px] text-muted">Pour la désactiver, confirmez votre mot de passe<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} /></label>
          <label className="mt-2 block text-[12.5px] text-muted">Et le code à 6 chiffres de votre application<input value={code} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} className={field} /></label>
          <Button variant="danger" className="mt-2" disabled={!password || code.length < 6} onClick={disable}>Désactiver</Button>
        </div>
      ) : setup ? (
        <div>
          <p className="text-[13.5px]">Scannez ce code avec votre application (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
          <img src={setup.qr} alt="Code QR de configuration" width={180} height={180} className="my-3 rounded-lg bg-white p-1" />
          <p className="text-[12px] text-muted">Ou saisissez cette clé : <code className="break-all">{setup.secret}</code></p>
          <label className="mt-3 block text-[12.5px] text-muted">Code à 6 chiffres affiché par l'application<input value={code} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} className={field} /></label>
          <Button variant="primary" className="mt-2" disabled={code.length < 6} onClick={confirm}>Activer</Button>
        </div>
      ) : (
        <div><p className="text-[13.5px] text-muted">Protège votre compte même si votre mot de passe est découvert.</p><Button variant="primary" className="mt-3" onClick={start}>Configurer</Button></div>
      )}
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionInfo[]>("/api/auth/sessions") });
  const revoke = (id: string) => api.del(`/api/auth/sessions/${id}`).then(() => qc.invalidateQueries({ queryKey: ["sessions"] }), failure);
  return (
    <Card icon={<Laptop className="size-4 text-muted" />} title="Appareils connectés">
      {!data ? <Spinner /> : (
        <ul className="divide-y divide-line">
          {data.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{s.user_agent || "Appareil inconnu"}</span><span className="block text-[12px] text-faint">{s.ip ?? "Adresse inconnue"} · dernière activité {ago(s.last_seen_at)}</span></span>
              {s.current ? <Chip tone="success">Cet appareil</Chip> : <Button size="sm" onClick={() => revoke(s.id)}>Déconnecter</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
