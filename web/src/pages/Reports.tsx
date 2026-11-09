import { FileBarChart } from "lucide-react";
import { ReportsPanel } from "@/components/Reports";
import { useMe } from "@/lib/hooks";

export function ReportsPage() {
  const { data: me } = useMe();
  const role = me?.orgs.find((o) => o.id === me.org_id)?.role;
  return (
    <div className="pb-16 pt-8">
      <header className="mx-auto max-w-[1180px] px-4 sm:px-8">
        <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-ai-fg"><FileBarChart className="size-3.5" />Rapports IA</p>
        <h1 className="mt-2 font-serif text-[34px] leading-[1.05] tracking-[-0.02em] sm:text-[40px]">Vue d'ensemble du portefeuille</h1>
        <p className="mt-2 max-w-2xl text-[13.5px] text-muted">Un coéquipier IA analyse tous vos projets communs et rédige un rapport. Il reste visible de vous seul. Pour un rapport partagé avec une équipe, ouvrez l'onglet Rapports d'un projet.</p>
      </header>
      <ReportsPanel projectId={null} canGenerate={!!role && role !== "guest"} />
    </div>
  );
}
