import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, Network, Plus, Trash2, Users } from "lucide-react";
import { Avatar, Button, Empty, Spinner, cn } from "@/components/ui";
import { AssigneePicker } from "@/components/pickers";
import { ORG_ROLE } from "@/components/Sidebar";
import { useMe, useTeams, useUnits, useUserMap, useUsers } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { OrgUnit } from "@/lib/types";

const KINDS = ["Organisation", "Filiale", "Direction", "Département", "Pôle", "Service", "Site"];

export function OrganizationPage() {
  const { data: me } = useMe();
  const { data: units, isLoading } = useUnits();
  const { data: people } = useUsers();
  const [tab, setTab] = useState<"tree" | "people">("tree");
  const org = me?.orgs.find((o) => o.id === me.org_id);
  const isAdmin = org?.role === "owner" || org?.role === "admin";
  const humans = (people ?? []).filter((u) => !u.is_ai);

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-8">
      <header className="mb-6">
        <p className="flex items-center gap-1.5 text-[13px] text-muted"><Network className="size-4" />Organisation</p>
        <h1 className="mt-1 text-[28px] font-semibold tracking-[-0.02em]">{org?.name}</h1>
        <p className="mt-1 text-[13px] text-muted tabular">
          {units?.length ?? 0} entités · {humans.length} personnes · {(people ?? []).filter((u) => u.is_ai).length} coéquipiers IA
          {!isAdmin && " · lecture seule"}
        </p>
      </header>
      <div className="mb-5 flex gap-1 border-b border-line">
        {([["tree", "Organigramme"], ["people", "Personnes"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-2.5 pb-2.5 text-[13.5px]", tab === k ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>{l}</button>
        ))}
      </div>
      {isLoading ? <Spinner /> : tab === "tree" ? <Tree units={units ?? []} isAdmin={isAdmin} /> : <People units={units ?? []} isAdmin={isAdmin} />}
    </div>
  );
}

function Tree({ units, isAdmin }: { units: OrgUnit[]; isAdmin: boolean }) {
  const users = useUserMap();
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const children = useMemo(() => { const m = new Map<string | null, OrgUnit[]>(); for (const u of units) m.set(u.parent_id, [...(m.get(u.parent_id) ?? []), u]); return m; }, [units]);
  const hidden = useMemo(() => {
    const h = new Set<string>();
    const hide = (id: string) => { for (const c of children.get(id) ?? []) { h.add(c.id); hide(c.id); } };
    collapsed.forEach(hide);
    return h;
  }, [collapsed, children]);
  const current = units.find((u) => u.id === (selected ?? units[0]?.id));
  if (!units.length) return <Empty title="Aucune entité">Créez la structure de votre organisation.</Empty>;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm" aria-label="Organigramme">
        {units.filter((u) => !hidden.has(u.id)).map((u) => {
          const kids = children.get(u.id)?.length ?? 0;
          const manager = u.manager_id ? users.get(u.manager_id) : null;
          return (
            <div key={u.id} className={cn("flex h-12 items-center gap-2 border-b border-line pr-4 last:border-b-0", current?.id === u.id ? "bg-active" : "hover:bg-hover")}
              style={{ paddingLeft: 12 + u.depth * 22 }}>
              <button aria-label={`${collapsed.has(u.id) ? "Déplier" : "Replier"} ${u.name}`} aria-expanded={!collapsed.has(u.id)} tabIndex={kids ? 0 : -1}
                onClick={() => { const n = new Set(collapsed); n.has(u.id) ? n.delete(u.id) : n.add(u.id); setCollapsed(n); }}
                className={cn("flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover", !kids && "invisible")}>
                <ChevronRight className={cn("size-3.5 transition-transform", !collapsed.has(u.id) && "rotate-90")} />
              </button>
              <button onClick={() => setSelected(u.id)} aria-current={current?.id === u.id ? "true" : undefined} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13.5px]", u.depth === 0 ? "font-semibold" : "font-medium")}>{u.name}</span>
                  <span className="block truncate text-[11.5px] text-faint">{u.kind}{u.team_count ? ` · ${u.team_count} équipe(s)` : ""}{u.member_count ? ` · ${u.member_count} pers.` : ""}</span>
                </span>
                {manager && <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex"><Avatar user={manager} size={20} />{manager.name.split(" ")[0]}</span>}
              </button>
            </div>
          );
        })}
      </section>
      {current && <UnitDetail key={current.id} unit={current} units={units} isAdmin={isAdmin} onSelect={setSelected} />}
    </div>
  );
}

function UnitDetail({ unit, units, isAdmin, onSelect }: { unit: OrgUnit; units: OrgUnit[]; isAdmin: boolean; onSelect: (id: string) => void }) {
  const qc = useQueryClient();
  const users = useUserMap();
  const { data: people } = useUsers();
  const { data: teams } = useTeams();
  const [name, setName] = useState(unit.name);
  const [child, setChild] = useState("");
  const humans = (people ?? []).filter((u) => !u.is_ai);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["units"] }); qc.invalidateQueries({ queryKey: ["users"] }); };
  const patch = (body: Record<string, unknown>, ok?: string) => api.patch(`/api/units/${unit.id}`, body).then(() => { refresh(); if (ok) toast.success(ok); }, (e) => toast.error(e.message));
  // Une entité ne peut pas être déplacée sous elle-même ni sous ses descendantes
  const descendants = useMemo(() => {
    const out = new Set([unit.id]);
    let added = true;
    while (added) { added = false; for (const u of units) if (u.parent_id && out.has(u.parent_id) && !out.has(u.id)) { out.add(u.id); added = true; } }
    return out;
  }, [unit.id, units]);
  const manager = unit.manager_id ? users.get(unit.manager_id) : null;
  const sub = units.filter((u) => u.parent_id === unit.id);
  const unitTeams = (teams ?? []).filter((t) => t.unit_id === unit.id);
  const members = humans.filter((u) => u.unit_id === unit.id);
  const field = "h-9 w-full rounded-lg border border-line bg-bg/60 px-2.5 text-[13.5px] outline-none focus:border-line-strong disabled:opacity-70";

  return (
    <aside className="space-y-5 rounded-2xl border border-line bg-panel p-5 shadow-sm lg:sticky lg:top-4 lg:self-start">
      <div className="space-y-3">
        <input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== unit.name && patch({ name: name.trim() }, "Entité renommée")}
          aria-label="Nom de l'entité" className="w-full rounded-md bg-transparent text-[19px] font-semibold tracking-[-0.01em] outline-none hover:bg-hover focus:bg-hover disabled:hover:bg-transparent" />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[12px] text-muted">Type
            <select value={unit.kind} disabled={!isAdmin} onChange={(e) => patch({ kind: e.target.value })} className={cn(field, "mt-1")}>
              {[...new Set([...KINDS, unit.kind])].map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-muted">Rattachée à
            <select value={unit.parent_id ?? ""} disabled={!isAdmin || !unit.parent_id} onChange={(e) => patch({ parent_id: e.target.value }, "Entité déplacée")} className={cn(field, "mt-1")}>
              {!unit.parent_id && <option value="">Racine</option>}
              {units.filter((u) => !descendants.has(u.id)).map((u) => <option key={u.id} value={u.id}>{"  ".repeat(u.depth)}{u.name}</option>)}
            </select>
          </label>
        </div>
        <div className="text-[12px] text-muted">Responsable
          <AssigneePicker memberIds={humans.map((u) => u.id)} value={unit.manager_id} onChange={(id) => isAdmin && patch({ manager_id: id }, "Responsable mis à jour")}>
            <button disabled={!isAdmin} className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-bg/60 px-2.5 text-left text-[13.5px] text-fg">
              <Avatar user={manager} size={20} />{manager?.name ?? <span className="text-faint">Aucun</span>}
            </button>
          </AssigneePicker>
          <p className="mt-1 text-[11.5px] text-faint">Le responsable voit en lecture les projets de toute sa branche, sauf ceux des équipes privées.</p>
        </div>
      </div>

      <Block title={`Sous-entités · ${sub.length}`}>
        {sub.map((u) => <button key={u.id} onClick={() => onSelect(u.id)} className="flex h-8 w-full items-center justify-between rounded-md px-2 text-left text-[13px] hover:bg-hover"><span>{u.name}</span><span className="text-[11.5px] text-faint">{u.kind}</span></button>)}
        {isAdmin && (
          <div className="mt-1 flex items-center gap-2">
            <input value={child} onChange={(e) => setChild(e.target.value)} placeholder="Nouvelle sous-entité" aria-label="Nom de la nouvelle sous-entité"
              onKeyDown={(e) => e.key === "Enter" && child.trim() && api.post("/api/org/units", { name: child.trim(), parent_id: unit.id, kind: "Service" }).then(() => { setChild(""); refresh(); toast.success("Sous-entité créée"); }, (er) => toast.error(er.message))}
              className={field} />
            <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!child.trim()} onClick={() => api.post("/api/org/units", { name: child.trim(), parent_id: unit.id, kind: "Service" }).then(() => { setChild(""); refresh(); toast.success("Sous-entité créée"); }, (er) => toast.error(er.message))}>Ajouter</Button>
          </div>
        )}
      </Block>

      <Block title={`Équipes · ${unitTeams.length}`}>
        {unitTeams.map((t) => <Link key={t.id} to={`/teams/${t.id}`} className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover"><span className="size-2.5 rounded-sm" style={{ background: t.color }} />{t.name}<span className="ml-auto text-[11.5px] text-faint">{t.member_count} membre(s)</span></Link>)}
        {!unitTeams.length && <p className="px-2 text-[12.5px] text-faint">Aucune équipe rattachée.</p>}
      </Block>

      <Block title={`Personnes · ${members.length}`}>
        <div className="flex flex-wrap gap-1.5">
          {members.map((u) => <span key={u.id} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12.5px]"><Avatar user={u} size={18} />{u.name}</span>)}
          {!members.length && <p className="px-2 text-[12.5px] text-faint">Personne n'est rattaché ici.</p>}
        </div>
      </Block>

      {isAdmin && unit.parent_id && (
        <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />}
          onClick={() => api.del(`/api/units/${unit.id}`).then(() => { refresh(); onSelect(unit.parent_id!); toast.success("Entité supprimée"); }, (e) => toast.error(e.message))}>
          Supprimer l'entité
        </Button>
      )}
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="mb-1.5 text-[12px] font-medium text-muted">{title}</h3>{children}</section>;
}

function People({ units, isAdmin }: { units: OrgUnit[]; isAdmin: boolean }) {
  const { data: people } = useUsers();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const set = (url: string, body: unknown, ok: string) => api.put(url, body).then(() => { qc.invalidateQueries({ queryKey: ["users"] }); qc.invalidateQueries({ queryKey: ["units"] }); toast.success(ok); }, (e) => toast.error(e.message));
  const sel = "h-8 max-w-[220px] rounded-md border border-line bg-bg/60 px-2 text-[12.5px] outline-none disabled:border-transparent disabled:bg-transparent";
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr><th className="px-4 py-2.5 font-medium">Personne</th><th className="px-2 font-medium">Rôle</th><th className="px-2 font-medium">Entité</th></tr></thead>
        <tbody>
          {(people ?? []).filter((u) => u.id !== "ai_cadence").map((u) => (
            <tr key={u.id} className="border-b border-line last:border-b-0">
              <td className="px-4 py-2.5"><span className="flex items-center gap-2.5"><Avatar user={u} size={26} /><span><span className="block font-medium">{u.name}</span><span className="block text-[12px] text-faint">{u.is_ai ? "Coéquipier IA" : u.title}</span></span></span></td>
              <td className="px-2">
                <select aria-label={`Rôle de ${u.name}`} disabled={!isAdmin || u.id === me?.id} value={u.org_role} className={sel}
                  onChange={(e) => set(`/api/org/members/${u.id}`, { role: e.target.value }, "Rôle mis à jour")}>
                  {Object.entries(ORG_ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </td>
              <td className="px-2">
                <select aria-label={`Entité de ${u.name}`} disabled={!isAdmin} value={u.unit_id ?? ""} className={sel}
                  onChange={(e) => set(`/api/org/members/${u.id}/unit`, { unit_id: e.target.value || null }, "Rattachement mis à jour")}>
                  <option value="">Non rattaché</option>
                  {units.map((x) => <option key={x.id} value={x.id}>{" ".repeat(x.depth * 2)}{x.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-[12px] text-faint"><Users className="size-3.5" />Les invités n'accèdent qu'aux projets partagés avec eux ; ils ne voient ni les équipes ni l'organigramme.</p>
    </div>
  );
}
