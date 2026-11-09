import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileQuestion } from "lucide-react";
import { Button, Dialog, Empty, Spinner, cn } from "./ui";
import { api } from "@/lib/api";
import type { Attachment, AttachmentPreviewData } from "@/lib/types";

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;

/** Aperçu d'une pièce jointe sans quitter la tâche. Tout passe en texte : aucun HTML venu d'un fichier n'est injecté. */
export function AttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const url = attachmentUrl(attachment.id);
  const { data, isLoading, error } = useQuery({
    queryKey: ["attachment-preview", attachment.id],
    queryFn: () => api.get<AttachmentPreviewData>(`${url}/preview`),
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      width={1040}
      title={attachment.filename}
      footer={
        <>
          <a href={url} download={attachment.filename}>
            <Button icon={<Download className="size-3.5" />}>Télécharger</Button>
          </a>
          <Button variant="primary" onClick={onClose}>
            Fermer
          </Button>
        </>
      }
    >
      {isLoading && (
        <div className="flex h-48 items-center justify-center">
          <Spinner />
        </div>
      )}
      {error && <p className="text-[13.5px] text-danger">{(error as Error).message}</p>}
      {data && <Body data={data} url={url} name={attachment.filename} />}
    </Dialog>
  );
}

function Body({ data, url, name }: { data: AttachmentPreviewData; url: string; name: string }) {
  if (data.kind === "image")
    return (
      <img src={`${url}?inline=1`} alt={name} className="mx-auto max-h-[68vh] max-w-full rounded-lg object-contain" />
    );
  if (data.kind === "pdf")
    return (
      <iframe src={`${url}?inline=1`} title={name} className="h-[68vh] w-full rounded-lg border border-line bg-white" />
    );
  if (data.kind === "sheets") return <Sheets sheets={data.sheets} truncated={data.truncated} />;
  if (data.kind === "document")
    return (
      <>
        <Truncated on={data.truncated} />
        <Document text={data.text} />
      </>
    );
  if (data.kind === "text")
    return (
      <>
        <Truncated on={data.truncated} />
        <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">{data.text}</pre>
      </>
    );
  return (
    <Empty icon={<FileQuestion className="size-7" />} title="Aperçu indisponible">
      Ce type de fichier ne peut pas s'afficher ici, ou il n'a pas pu être lu. Vous pouvez le télécharger.
    </Empty>
  );
}

const Truncated = ({ on }: { on: boolean }) =>
  on ? (
    <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
      Fichier très long : seule sa première partie est affichée. Téléchargez-le pour tout voir.
    </p>
  ) : null;

function Document({ text }: { text: string }) {
  return (
    <div className="mx-auto max-w-[720px] space-y-2 text-[14px] leading-relaxed">
      {text.split("\n").map((line, i) => {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading)
          return (
            <p
              key={i}
              className={cn(
                "font-semibold",
                heading[1].length === 1
                  ? "pt-2 text-[20px]"
                  : heading[1].length === 2
                    ? "pt-1 text-[16px]"
                    : "text-[14.5px]",
              )}
            >
              {heading[2]}
            </p>
          );
        const item = line.match(/^(\s*)-\s+(.*)$/);
        if (item)
          return (
            <p key={i} style={{ paddingLeft: item[1].length * 8 + 12, textIndent: -12 }}>
              • {item[2]}
            </p>
          );
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

function Sheets({ sheets, truncated }: { sheets: { name: string; rows: string[][] }[]; truncated: boolean }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  if (!sheet?.rows.length) return <p className="text-[13.5px] text-muted">Cette feuille est vide.</p>;
  const [head, ...rows] = sheet.rows;
  return (
    <div>
      <Truncated on={truncated} />
      {sheets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              className={cn(
                "h-7 rounded-md px-2.5 text-[12.5px]",
                i === active ? "bg-active font-medium text-fg" : "text-muted hover:bg-hover",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[62vh] overflow-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 bg-raised">
            <tr>
              {head.map((c, i) => (
                <th key={i} className="whitespace-nowrap border-b border-line px-2.5 py-1.5 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-b-0">
                {head.map((_, j) => (
                  <td key={j} className="max-w-[320px] px-2.5 py-1.5 align-top">
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
