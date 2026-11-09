/** Type réel d'un fichier, établi d'après son contenu : l'extension seule ne prouve rien. */
export type FileKind = "image" | "pdf" | "word" | "excel" | "powerpoint" | "zip" | "legacy-word" | "legacy-excel" | "legacy-powerpoint" | "text" | "csv";
export interface FileType { mime: string; kind: FileKind }

const OOXML: Record<string, FileType> = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "word" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "excel" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "powerpoint" },
};
const LEGACY: Record<string, FileType> = {
  doc: { mime: "application/msword", kind: "legacy-word" },
  xls: { mime: "application/vnd.ms-excel", kind: "legacy-excel" },
  ppt: { mime: "application/vnd.ms-powerpoint", kind: "legacy-powerpoint" },
};
const TEXT: Record<string, FileType> = {
  txt: { mime: "text/plain; charset=utf-8", kind: "text" }, md: { mime: "text/plain; charset=utf-8", kind: "text" }, log: { mime: "text/plain; charset=utf-8", kind: "text" },
  json: { mime: "application/json", kind: "text" }, csv: { mime: "text/csv; charset=utf-8", kind: "csv" },
};

const starts = (b: Buffer, bytes: number[]) => bytes.every((v, i) => b[i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString("latin1");

export function detectType(filename: string, data: Buffer): FileType | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", kind: "image" };
  if (starts(data, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" };
  if (ascii(data, 0, 4) === "GIF8") return { mime: "image/gif", kind: "image" };
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return { mime: "image/webp", kind: "image" };
  if (ascii(data, 0, 5) === "%PDF-") return { mime: "application/pdf", kind: "pdf" };
  if (starts(data, [0x50, 0x4b, 0x03, 0x04])) {
    if (OOXML[ext]) return data.includes("[Content_Types].xml") ? OOXML[ext] : null;
    return ext === "zip" ? { mime: "application/zip", kind: "zip" } : null;
  }
  if (starts(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return LEGACY[ext] ?? null;
  if (TEXT[ext] && !data.subarray(0, 8192).includes(0)) return TEXT[ext];
  return null;
}

export const ALLOWED_FORMATS = "images (PNG, JPEG, GIF, WebP), PDF, Word, Excel, PowerPoint, ZIP, texte ou CSV";
