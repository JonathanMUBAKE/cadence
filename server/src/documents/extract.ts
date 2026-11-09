import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";
import { HttpError, badRequest } from "../services.js";
import { detectType, type FileKind } from "./filetypes.js";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX_CHARS = 150_000;
const UNZIPPED_MAX_BYTES = 100 * 1024 * 1024;
const PREVIEW_MAX_ROWS = 500;
const PREVIEW_MAX_COLUMNS = 40;

export interface Sheet {
  name: string;
  rows: string[][];
}
export type Preview =
  | { kind: "image" | "pdf" | "none" }
  | { kind: "document" | "text"; text: string; truncated: boolean }
  | { kind: "sheets"; sheets: Sheet[]; truncated: boolean };

/** Taille décompressée annoncée par une archive, lue sans la décompresser. */
export function zipUncompressedSize(data: Buffer): number {
  const floor = Math.max(0, data.length - 65_557);
  let end = -1;
  for (let i = data.length - 22; i >= floor; i--)
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return Number.POSITIVE_INFINITY;
  const entries = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) return Number.POSITIVE_INFINITY;
    total += data.readUInt32LE(at + 24);
    at += 46 + data.readUInt16LE(at + 28) + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return total;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return entities[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

/** HTML produit par mammoth → plan en texte : titres, listes imbriquées et tableaux restent lisibles. */
function outline(html: string) {
  const lines: string[] = [];
  let current = "",
    depth = 0,
    inItem = 0;
  const flush = () => {
    const t = current.replace(/(\s*\|\s*)+$/, "").trimEnd();
    if (t.trim() && !/^\s*-\s*$/.test(t)) lines.push(t);
    current = "";
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)\b[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      current += decode(m[3]);
      continue;
    }
    const closing = !!m[1],
      tag = m[2].toLowerCase();
    if (tag === "ul" || tag === "ol") depth += closing ? -1 : 1;
    else if (tag === "li") {
      flush();
      inItem += closing ? -1 : 1;
      if (!closing) current = `${"  ".repeat(Math.max(0, depth - 1))}- `;
    } else if (/^h[1-6]$/.test(tag)) {
      flush();
      if (!closing) current = `${"#".repeat(Number(tag[1]))} `;
    } else if (tag === "p") {
      if (!inItem) flush();
    } else if (tag === "tr") flush();
    else if ((tag === "td" || tag === "th") && closing) current = `${current.trim()} | `;
    else if (tag === "br") current += " ";
  }
  flush();
  return lines.join("\n");
}

async function readWord(data: Buffer) {
  // Les images n'apportent rien à la lecture et alourdiraient le texte transmis
  const options = { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) };
  return outline((await mammoth.convertToHtml({ buffer: data }, options)).value);
}

async function readLegacyWord(data: Buffer) {
  return (await new WordExtractor().extract(data)).getBody();
}

async function readPdf(data: Buffer) {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: false });
  return text
    .map((page) => page.trim())
    .filter(Boolean)
    .join("\n\n");
}

function decodeText(data: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  } // CSV enregistrés par Excel sous Windows
}

function sheetsOf(wb: XLSX.WorkBook): Sheet[] {
  return wb.SheetNames.filter((_, i) => !wb.Workbook?.Sheets?.[i]?.Hidden).map((name) => ({
    name,
    rows: XLSX.utils
      .sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, blankrows: false, defval: "" })
      .map((r) =>
        r.map((c) =>
          String(c ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      ),
  }));
}
const readWorkbook = (data: Buffer, sheetRows?: number) =>
  sheetsOf(XLSX.read(data, { type: "buffer", cellDates: true, dateNF: "yyyy-mm-dd", UTC: true, sheetRows }));
const readCsv = (data: Buffer, sheetRows?: number) =>
  sheetsOf(XLSX.read(decodeText(data), { type: "string", raw: true, sheetRows }));
const sheetsToText = (sheets: Sheet[]) =>
  sheets
    .flatMap((s) => [
      `## Feuille : ${s.name}`,
      ...s.rows.map((r) => r.join(" | ").replace(/(\s*\|\s*)+$/, "")).filter(Boolean),
    ])
    .join("\n");

function guardArchive(kind: FileKind, data: Buffer) {
  if (["word", "excel", "powerpoint"].includes(kind) && zipUncompressedSize(data) > UNZIPPED_MAX_BYTES)
    throw new HttpError(413, "Fichier trop volumineux une fois décompressé");
}

const READERS: Partial<Record<FileKind, (data: Buffer) => string | Promise<string>>> = {
  word: readWord,
  "legacy-word": readLegacyWord,
  pdf: readPdf,
  text: decodeText,
  csv: decodeText,
  excel: (d) => sheetsToText(readWorkbook(d)),
  "legacy-excel": (d) => sheetsToText(readWorkbook(d)),
};

/** Texte structuré d'un fichier, pour l'import et pour la lecture par les coéquipiers IA. */
export async function extractDocument(filename: string, data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const type = detectType(filename, data);
  const read = type && READERS[type.kind];
  if (!type || !read)
    throw new HttpError(415, "Format non pris en charge pour la lecture : Word, Excel, PDF, CSV ou texte");
  guardArchive(type.kind, data);
  let text: string;
  try {
    text = await read(data);
  } catch {
    throw badRequest("Ce fichier n'a pas pu être lu : il est peut-être endommagé ou protégé par un mot de passe");
  }
  if (!text.trim())
    throw badRequest(
      type.kind === "pdf"
        ? "Aucun texte n'a pu être lu dans ce PDF : il s'agit sans doute d'un document scanné"
        : "Aucun texte n'a pu être lu dans ce fichier",
    );
  return { text: text.slice(0, TEXT_MAX_CHARS), truncated: text.length > TEXT_MAX_CHARS };
}

/** Contenu à afficher dans l'aperçu. Word passe par du texte structuré : aucun HTML venu d'un fichier n'atteint la page. */
export async function previewDocument(filename: string, data: Buffer): Promise<Preview> {
  const type = detectType(filename, data);
  if (!type) return { kind: "none" };
  if (type.kind === "image" || type.kind === "pdf") return { kind: type.kind };
  if (type.kind === "excel" || type.kind === "legacy-excel" || type.kind === "csv") {
    guardArchive(type.kind, data);
    try {
      // Une ligne de plus que le maximum : c'est ainsi qu'on sait que le tableau continue
      const all = (type.kind === "csv" ? readCsv : readWorkbook)(data, PREVIEW_MAX_ROWS + 1);
      const truncated = all.some(
        (s) => s.rows.length > PREVIEW_MAX_ROWS || s.rows.some((r) => r.length > PREVIEW_MAX_COLUMNS),
      );
      return {
        kind: "sheets",
        truncated,
        sheets: all.map((s) => ({
          name: s.name,
          rows: s.rows.slice(0, PREVIEW_MAX_ROWS).map((r) => r.slice(0, PREVIEW_MAX_COLUMNS)),
        })),
      };
    } catch {
      return { kind: "none" };
    }
  }
  if (type.kind === "word" || type.kind === "legacy-word" || type.kind === "text") {
    try {
      const { text, truncated } = await extractDocument(filename, data);
      return { kind: type.kind === "text" ? "text" : "document", text, truncated };
    } catch {
      return { kind: "none" };
    }
  }
  return { kind: "none" };
}
