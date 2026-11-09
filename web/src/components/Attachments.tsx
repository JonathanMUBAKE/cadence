import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Paperclip,
  Presentation,
  Trash2,
} from "lucide-react";
import { Button, IconButton, cn } from "./ui";
import { AttachmentPreview, attachmentUrl } from "./AttachmentPreview";
import { useMe, useUserMap } from "@/lib/hooks";
import { ago } from "@/lib/format";
import { api } from "@/lib/api";
import type { Attachment, TaskDetail } from "@/lib/types";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

function iconFor(mime: string) {
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime.startsWith("text/csv")) return FileSpreadsheet;
  if (mime.includes("presentation") || mime.includes("powerpoint")) return Presentation;
  if (mime.includes("zip")) return FileArchive;
  if (mime.includes("word") || mime.includes("pdf") || mime.startsWith("text/")) return FileText;
  return FileIcon;
}

/** Fichiers joints à une tâche : envoi par bouton ou glisser-déposer. */
export function Attachments({ t }: { t: TaskDetail }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const canUpload = t.role !== "viewer";
  const list = t.attachments.filter((a) => !a.comment_id);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    let sent = 0;
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        toast.error(`« ${file.name} » dépasse 25 Mo`);
        continue;
      }
      try {
        await api.upload(`/api/tasks/${t.id}/attachments`, file);
        sent++;
      } catch (e) {
        toast.error(`« ${file.name} » : ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    if (sent) {
      qc.invalidateQueries({ queryKey: ["task", t.id] });
      toast.success(sent > 1 ? `${sent} fichiers joints` : "Fichier joint");
    }
  };

  return (
    <section
      className={cn("mt-7 rounded-lg transition-colors", over && "bg-ai-soft/50 outline outline-1 outline-ai-line")}
      onDragOver={(e) => {
        if (canUpload && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setOver(false);
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Pièces jointes</h3>
        {list.length > 0 && <span className="text-[12px] tabular text-faint">{list.length}</span>}
        {canUpload && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            loading={busy}
            icon={<Paperclip className="size-3.5" />}
            onClick={() => input.current?.click()}
          >
            Joindre
          </Button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Joindre des fichiers"
          onChange={(e) => void send([...(e.target.files ?? [])])}
        />
      </div>
      {list.length === 0 ? (
        <p className="px-1 py-1 text-[13px] text-faint">
          {canUpload ? "Glissez des fichiers ici ou cliquez sur Joindre (25 Mo maximum)." : "Aucune pièce jointe."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <AttachmentRow key={a.id} a={a} taskId={t.id} isAdmin={t.role === "admin"} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function AttachmentRow({ a, taskId, isAdmin }: { a: Attachment; taskId: string; isAdmin: boolean }) {
  const users = useUserMap();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const Icon = iconFor(a.mime);
  const url = attachmentUrl(a.id);
  const remove = async () => {
    try {
      await api.del(url);
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      toast.success("Pièce jointe supprimée");
    } catch (e) {
      toast.error((e as Error).message);
      setConfirming(false);
    }
  };
  return (
    <li className="group flex min-h-12 items-center gap-2.5 px-1 py-1.5">
      {previewing && <AttachmentPreview attachment={a} onClose={() => setPreviewing(false)} />}
      <button
        type="button"
        aria-label={`Aperçu de ${a.filename}`}
        onClick={() => setPreviewing(true)}
        className="shrink-0"
      >
        {a.mime.startsWith("image/") ? (
          <img
            src={`${url}?inline=1`}
            alt=""
            loading="lazy"
            className="size-9 rounded-md border border-line object-cover"
          />
        ) : (
          <span className="flex size-9 items-center justify-center rounded-md bg-hover text-muted">
            <Icon className="size-4" />
          </span>
        )}
      </button>
      <span className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          className="block max-w-full truncate text-left text-[13.5px] hover:underline"
        >
          {a.filename}
        </button>
        <span className="block truncate text-[12px] text-faint">
          {formatSize(a.size)} · {users.get(a.uploader_id)?.name ?? "Inconnu"} · {ago(a.created_at)}
        </span>
      </span>
      {confirming ? (
        <span className="flex shrink-0 gap-1">
          <Button size="sm" variant="danger" onClick={remove}>
            Supprimer
          </Button>
          <Button size="sm" onClick={() => setConfirming(false)}>
            Annuler
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <a
            href={url}
            download={a.filename}
            aria-label={`Télécharger ${a.filename}`}
            title="Télécharger"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <Download className="size-3.5" />
          </a>
          {(a.uploader_id === me?.id || isAdmin) && (
            <IconButton size="sm" label={`Supprimer ${a.filename}`} onClick={() => setConfirming(true)}>
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </span>
      )}
    </li>
  );
}
