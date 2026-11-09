import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, Trash2 } from "lucide-react";
import { Avatar, Button, cn } from "./ui";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";

/**
 * Recadre l'image au carré (centre) et la réduit à 320 px avant l'envoi :
 * le fichier reste léger (quelques dizaines de Ko) quelle que soit la photo d'origine.
 */
async function toSquareDataUrl(file: File, px = 320): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Ce fichier n'est pas une image lisible"); });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(px, side);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const webp = canvas.toDataURL("image/webp", 0.86);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.88);
}

export function AvatarUpload({ user, size = 72, editable = true, compact }: { user: User; size?: number; editable?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => ["me", "users", "agents", "team"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const pick = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Choisissez une image (PNG, JPEG, WebP…)");
    setBusy(true);
    try {
      await api.put(`/api/users/${user.id}/avatar`, { data_url: await toSquareDataUrl(file) });
      refresh();
      toast.success("Photo mise à jour");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.del(`/api/users/${user.id}/avatar`); refresh(); toast.success("Photo retirée"); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const fileInput = <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pick(e.target.files?.[0])} />;

  if (compact) {
    return (
      <>
        {fileInput}
        <button type="button" disabled={!editable || busy} onClick={() => input.current?.click()} aria-label={`Changer la photo de ${user.name}`} title={editable ? "Changer la photo" : user.name}
          className={cn("group relative shrink-0 rounded-full", editable && "cursor-pointer", busy && "animate-pulse")}>
          <Avatar user={user} size={size} />
          {editable && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Camera style={{ width: size * 0.42, height: size * 0.42 }} /></span>}
        </button>
      </>
    );
  }

  return (
    <div className="flex items-center gap-4">
      {fileInput}
      <button type="button" disabled={!editable || busy} onClick={() => input.current?.click()} aria-label={`Changer la photo de ${user.name}`}
        className={cn("group relative shrink-0 rounded-full", busy && "animate-pulse")}>
        <Avatar user={user} size={size} />
        {editable && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Camera className="size-5" /></span>}
      </button>
      {editable && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Camera className="size-3.5" />} loading={busy} onClick={() => input.current?.click()}>{user.avatar_url ? "Changer la photo" : "Ajouter une photo"}</Button>
            {user.avatar_url && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={remove}>Retirer</Button>}
          </div>
          <p className="text-[11.5px] text-faint">Recadrée au carré automatiquement. PNG, JPEG, WebP ou GIF.</p>
        </div>
      )}
    </div>
  );
}
