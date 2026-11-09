import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Button, Spinner } from "@/components/ui";
import { Logo } from "@/components/Sidebar";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";

type Step = "login" | "mfa" | "forgot" | "request" | "sent";
export const authField = "mt-1 h-10 w-full rounded-lg border border-line bg-bg/60 px-3 text-[14px] text-fg outline-none focus:border-line-strong";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grain flex min-h-full flex-col bg-bg lg:flex-row">
      <section className="relative flex flex-1 flex-col justify-between overflow-hidden px-6 py-8 sm:px-12 lg:py-12">
        <div className="flex items-center gap-2.5"><Logo size={30} /><span className="text-[16px] font-semibold tracking-[-0.01em]">Cadence</span></div>
        <div className="my-12 max-w-xl lg:my-0">
          <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-ai-line bg-ai-soft px-3 py-1 text-[12px] font-medium text-ai-fg">
            <Sparkles className="size-3.5" />Coéquipiers IA intégrés
          </motion.p>
          <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="font-serif text-[44px] leading-[1.02] tracking-[-0.02em] sm:text-[64px]">
            Le travail de l'équipe,<br /><span className="ai-text shimmer italic">et ceux qui l'aident.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Projets, tableaux, échéances et des coéquipiers IA à qui l'on confie une tâche comme à un collègue, avec votre accord avant chaque modification.
          </motion.p>
        </div>
        <span />
      </section>
      <section className="flex w-full items-center justify-center border-t border-line bg-panel px-6 py-10 lg:w-[480px] lg:border-l lg:border-t-0">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["auth-config"], queryFn: () => api.get<{ demo: boolean; registration: "invite" | "approval" }>("/api/auth/config") });
  const { data: users, isLoading } = useQuery({ queryKey: ["login-users"], queryFn: () => api.get<User[]>("/api/auth/users"), enabled: !!config?.demo });
  const [step, setStep] = useState<Step>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentText, setSentText] = useState("");

  const enter = () => { qc.clear(); nav("/"); };
  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await fn(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const login = run(async () => {
    const r = await api.post<{ status: "ok" | "mfa" }>("/api/auth/login", { email, password });
    setPassword("");
    if (r.status === "mfa") setStep("mfa"); else enter();
  });
  const mfa = run(async () => { await api.post("/api/auth/mfa", { code }); enter(); });
  const forgot = run(async () => { await api.post("/api/auth/forgot", { email }); setSentText("Si un compte existe pour cette adresse, un lien de réinitialisation vient d'être envoyé."); setStep("sent"); });
  const request = run(async () => { await api.post("/api/auth/request-access", { name, email, note }); setSentText("Votre demande est enregistrée. Vous recevrez un e-mail si un administrateur la valide."); setStep("sent"); });
  const demoLogin = async (id: string) => { await api.post("/api/auth/login", { user_id: id }); enter(); };
  const back = <button type="button" onClick={() => setStep("login")} className="mt-4 text-[13px] text-muted hover:text-fg">Retour à la connexion</button>;

  return (
    <AuthShell>
      {step === "login" && (
        <form onSubmit={login}>
          <h2 className="text-[20px] font-semibold">Connexion</h2>
          <label className="mt-5 block text-[12.5px] font-medium text-muted">Adresse e-mail<input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={authField} /></label>
          <label className="mt-3 block text-[12.5px] font-medium text-muted">Mot de passe<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={authField} /></label>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>Se connecter</Button>
          <div className="mt-4 flex justify-between text-[13px]">
            <button type="button" onClick={() => setStep("forgot")} className="text-muted hover:text-fg">Mot de passe oublié ?</button>
            {config?.registration === "approval" && <button type="button" onClick={() => setStep("request")} className="text-muted hover:text-fg">Demander un accès</button>}
          </div>
        </form>
      )}
      {step === "mfa" && (
        <form onSubmit={mfa}>
          <h2 className="flex items-center gap-2 text-[20px] font-semibold"><ShieldCheck className="size-5 text-ai-fg" />Double authentification</h2>
          <p className="mt-1 text-[13px] text-muted">Saisissez le code à 6 chiffres de votre application, ou un code de secours.</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="text" autoComplete="one-time-code" aria-label="Code de vérification" className={`${authField} mt-4 text-center font-mono tracking-[0.2em]`} />
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>Vérifier</Button>
          {back}
        </form>
      )}
      {step === "forgot" && (
        <form onSubmit={forgot}>
          <h2 className="text-[20px] font-semibold">Mot de passe oublié</h2>
          <p className="mt-1 text-[13px] text-muted">Indiquez votre adresse : nous vous enverrons un lien valable 30 minutes.</p>
          <label className="mt-4 block text-[12.5px] font-medium text-muted">Adresse e-mail<input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={authField} /></label>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>Envoyer le lien</Button>
          {back}
        </form>
      )}
      {step === "request" && (
        <form onSubmit={request}>
          <h2 className="text-[20px] font-semibold">Demander un accès</h2>
          <p className="mt-1 text-[13px] text-muted">Un administrateur examinera votre demande avant d'ouvrir votre compte.</p>
          <label className="mt-4 block text-[12.5px] font-medium text-muted">Nom complet<input required autoFocus value={name} onChange={(e) => setName(e.target.value)} className={authField} /></label>
          <label className="mt-3 block text-[12.5px] font-medium text-muted">Adresse e-mail<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={authField} /></label>
          <label className="mt-3 block text-[12.5px] font-medium text-muted">Message (facultatif)<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Votre équipe, votre fonction…" className={authField} /></label>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>Envoyer la demande</Button>
          {back}
        </form>
      )}
      {step === "sent" && <div><h2 className="text-[20px] font-semibold">C'est noté</h2><p className="mt-2 text-[14px] leading-relaxed text-muted">{sentText}</p>{back}</div>}

      {config?.demo && step === "login" && (
        <div className="mt-8 border-t border-line pt-6">
          <p className="text-[13px] font-medium">Mode démo : choisissez un profil</p>
          <div className="mt-3 space-y-1.5">
            {isLoading && <Spinner />}
            {users?.map((u) => (
              <button key={u.id} onClick={() => demoLogin(u.id)} className="group flex w-full items-center gap-3 rounded-xl border border-line bg-bg/50 px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-hover">
                <Avatar user={u} size={34} />
                <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{u.name}</span><span className="block truncate text-[12.5px] text-muted">{u.title}</span></span>
                <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
              </button>
            ))}
          </div>
        </div>
      )}
    </AuthShell>
  );
}
