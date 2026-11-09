import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mail } from "lucide-react";
import { api } from "@/lib/api";
import type { ReceivedInvitation } from "@/lib/types";
import { Button } from "./ui";

/** Invitations reçues : rien n'est rattaché au compte sans l'accord de la personne. */
export function PendingInvitations() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["my-invitations"], queryFn: () => api.get<ReceivedInvitation[]>("/api/invitations") });
  const answer = (i: ReceivedInvitation, decision: "accept" | "decline") => api.post(`/api/invitations/${i.id}/${decision}`).then(
    () => { void qc.invalidateQueries(); toast.success(decision === "accept" ? `Vous avez rejoint ${i.org_name}` : "Invitation refusée"); },
    (e: Error) => toast.error(e.message),
  );
  if (!data?.length) return null;
  return (
    <ul className="shrink-0 divide-y divide-line border-b border-line bg-panel">
      {data.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
          <Mail className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 text-[13px]"><strong className="font-semibold">{i.org_name}</strong> vous invite à rejoindre son espace, avec le profil {i.profile_name}.</span>
          <Button size="sm" variant="primary" onClick={() => answer(i, "accept")}>Accepter</Button>
          <Button size="sm" onClick={() => answer(i, "decline")}>Refuser</Button>
        </li>
      ))}
    </ul>
  );
}
