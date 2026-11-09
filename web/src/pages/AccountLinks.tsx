import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { AuthShell, authField } from "./Login";

export const PASSWORD_HINT =
  "12 caractères minimum. Une phrase de plusieurs mots est plus sûre et plus facile à retenir.";

function BadLink() {
  return (
    <div>
      <h2 className="text-[20px] font-semibold">Lien expiré</h2>
      <p className="mt-2 text-[14px] text-muted">
        Ce lien n'est plus valable. Demandez-en un nouveau à votre administrateur.
      </p>
      <Link to="/login" className="mt-4 inline-block text-[13px] text-muted hover:text-fg">
        Aller à la connexion
      </Link>
    </div>
  );
}

function PasswordFields({
  password,
  confirm,
  setPassword,
  setConfirm,
}: {
  password: string;
  confirm: string;
  setPassword: (v: string) => void;
  setConfirm: (v: string) => void;
}) {
  return (
    <>
      <label className="mt-3 block text-[12.5px] font-medium text-muted">
        Mot de passe
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={authField}
        />
      </label>
      <p className="mt-1 text-[12px] text-faint">{PASSWORD_HINT}</p>
      <label className="mt-3 block text-[12.5px] font-medium text-muted">
        Confirmer le mot de passe
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={authField}
        />
      </label>
    </>
  );
}

function useToken() {
  // Le jeton est après le # : le navigateur ne l'envoie jamais dans l'adresse
  const token = new URLSearchParams(useLocation().hash.slice(1)).get("token") ?? "";
  const peek = useQuery({
    queryKey: ["auth-token", token],
    queryFn: () =>
      api.post<{ kind: "invite" | "reset" | "setup"; email: string | null; name: string | null }>("/api/auth/token", {
        token,
      }),
    enabled: !!token,
    retry: false,
  });
  return { token, peek };
}

/** Dernière étape d'une invitation, ou création du premier administrateur. */
export function ActivationPage() {
  const nav = useNavigate();
  const { token, peek } = useToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const setup = peek.data?.kind === "setup";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Les deux mots de passe sont différents");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/activate", { token, password, ...(setup ? { name, email } : {}) });
      toast.success("Compte activé : vous pouvez vous connecter");
      nav("/login");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      {peek.isLoading ? (
        <Spinner />
      ) : !peek.data || peek.data.kind === "reset" ? (
        <BadLink />
      ) : (
        <form onSubmit={submit}>
          <h2 className="text-[20px] font-semibold">
            {setup ? "Créer l'administrateur système" : "Activer votre compte"}
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            {setup
              ? "Ce compte administrera la plateforme. Si l'adresse correspond à un compte existant, il sera élevé à ce rôle."
              : `${peek.data.name}, choisissez le mot de passe de ${peek.data.email}.`}
          </p>
          {setup && (
            <>
              <label className="mt-4 block text-[12.5px] font-medium text-muted">
                Nom complet
                <input
                  required
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={authField}
                />
              </label>
              <label className="mt-3 block text-[12.5px] font-medium text-muted">
                Adresse e-mail
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={authField}
                />
              </label>
            </>
          )}
          <PasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>
            Activer le compte
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPage() {
  const nav = useNavigate();
  const { token, peek } = useToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Les deux mots de passe sont différents");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/reset", { token, password });
      toast.success("Mot de passe modifié : toutes les sessions ont été fermées");
      nav("/login");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      {peek.isLoading ? (
        <Spinner />
      ) : peek.data?.kind !== "reset" ? (
        <BadLink />
      ) : (
        <form onSubmit={submit}>
          <h2 className="text-[20px] font-semibold">Nouveau mot de passe</h2>
          <p className="mt-1 text-[13px] text-muted">Pour {peek.data.email}.</p>
          <PasswordFields password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>
            Enregistrer
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
