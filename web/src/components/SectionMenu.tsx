import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { Button, Dialog, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui";
import { api } from "@/lib/api";
import type { Section } from "@/lib/types";

/** Actions sur une section : renommer, déplacer, supprimer. `axis` adapte les libellés (colonnes ou liste). */
export function SectionMenu({ section, sections, axis = "horizontal", taskCount, canDelete }: { section: Section; sections: Section[]; axis?: "horizontal" | "vertical"; taskCount: number; canDelete: boolean }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(section.name);
  const i = sections.findIndex((s) => s.id === section.id);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["project", section.project_id] }); qc.invalidateQueries({ queryKey: ["tasks"] }); };
  const call = (p: Promise<unknown>, ok?: string) => p.then(() => { refresh(); if (ok) toast.success(ok); }, (e) => toast.error((e as Error).message));
  const target = sections[i === 0 ? 1 : 0];
  const prev = axis === "horizontal" ? "Déplacer à gauche" : "Monter";
  const next = axis === "horizontal" ? "Déplacer à droite" : "Descendre";

  return (
    <>
      <Menu>
        <MenuTrigger asChild><IconButton size="sm" label={`Actions de la section ${section.name}`}><Ellipsis className="size-4" /></IconButton></MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil className="size-3.5" />} onSelect={() => { setName(section.name); setRenaming(true); }}>Renommer</MenuItem>
          {i > 0 && <MenuItem icon={<ArrowLeft className={axis === "vertical" ? "size-3.5 rotate-90" : "size-3.5"} />} onSelect={() => call(api.post(`/api/sections/${section.id}/move`, { direction: "left" }))}>{prev}</MenuItem>}
          {i < sections.length - 1 && <MenuItem icon={<ArrowRight className={axis === "vertical" ? "size-3.5 rotate-90" : "size-3.5"} />} onSelect={() => call(api.post(`/api/sections/${section.id}/move`, { direction: "right" }))}>{next}</MenuItem>}
          {canDelete && sections.length > 1 && <><MenuSeparator /><MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={() => setDeleting(true)}>Supprimer la section</MenuItem></>}
        </MenuContent>
      </Menu>

      <Dialog open={renaming} onOpenChange={setRenaming} title="Renommer la section" width={420}
        footer={<><Button onClick={() => setRenaming(false)}>Annuler</Button><Button variant="primary" disabled={!name.trim()} onClick={() => { call(api.patch(`/api/sections/${section.id}`, { name: name.trim() }), "Section renommée"); setRenaming(false); }}>Renommer</Button></>}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { call(api.patch(`/api/sections/${section.id}`, { name: name.trim() }), "Section renommée"); setRenaming(false); } }}
          className="h-10 w-full rounded-lg border border-line bg-bg/60 px-3 text-[14px] outline-none focus:border-line-strong" />
      </Dialog>

      <Dialog open={deleting} onOpenChange={setDeleting} title={`Supprimer « ${section.name} » ?`} width={440}
        description={taskCount ? `Ses ${taskCount} tâche(s) seront déplacées dans « ${target?.name} ». Rien n'est perdu.` : "La section est vide."}
        footer={<><Button onClick={() => setDeleting(false)}>Annuler</Button><Button variant="danger" onClick={() => { call(api.del(`/api/sections/${section.id}`), "Section supprimée"); setDeleting(false); }}>Supprimer la section</Button></>}>
        <p className="text-[13px] text-muted">Cette action ne supprime aucune tâche.</p>
      </Dialog>
    </>
  );
}
