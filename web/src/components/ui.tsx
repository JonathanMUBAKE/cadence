import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import * as DM from "@radix-ui/react-dropdown-menu";
import * as PO from "@radix-ui/react-popover";
import * as DI from "@radix-ui/react-dialog";
import * as TT from "@radix-ui/react-tooltip";
import { Check, Globe, LoaderCircle, Lock, Megaphone, Rocket, Smartphone, Sparkles, Target, X, Folder, Users, Brain } from "lucide-react";
import type { User } from "@/lib/types";

export const cn = clsx;

// ------------------------------------------------------------------ boutons
type Variant = "primary" | "secondary" | "ghost" | "ai" | "danger";
type Size = "sm" | "md" | "lg";
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button ref={ref} disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 select-none",
        size === "sm" && "h-7 rounded-md px-2.5 text-[12.5px]",
        size === "md" && "h-8 rounded-lg px-3 text-[13px]",
        size === "lg" && "h-10 rounded-[10px] px-4 text-sm",
        variant === "primary" && "bg-primary text-on-primary shadow-sm hover:opacity-90",
        variant === "secondary" && "border border-line bg-raised text-fg shadow-sm hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        variant === "ai" && "border border-ai-line bg-ai-soft text-ai-fg hover:bg-[color-mix(in_oklab,var(--ai)_16%,transparent)]",
        variant === "danger" && "border border-line bg-raised text-danger hover:bg-danger-soft",
        className)}
      {...rest}>
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }>(
  function IconButton({ label, size = "md", className, children, ...rest }, ref) {
    return (
      <button ref={ref} aria-label={label} title={label}
        className={cn("inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
          size === "sm" ? "size-6" : "size-8", className)} {...rest}>
        {children}
      </button>
    );
  });

export const Spinner = ({ className }: { className?: string }) => <LoaderCircle className={cn("size-4 animate-spin text-faint", className)} />;
export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-panel px-1 font-mono text-[10.5px] text-faint">{children}</kbd>
);

// ------------------------------------------------------------------ avatars
export function Avatar({ user, size = 22, ring }: { user?: User | null; size?: number; ring?: boolean }) {
  if (!user) {
    return <span className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-faint" style={{ width: size, height: size }}>
      <Users style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>;
  }
  if (user.is_ai) {
    return (
      <span title={user.name} className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full text-white", ring && "ring-2 ring-panel")}
        style={{ width: size, height: size, background: `conic-gradient(from 210deg, ${user.avatar_color}, #4FB3F0, ${user.avatar_color})` }}>
        <Sparkles style={{ width: size * 0.52, height: size * 0.52 }} strokeWidth={2.2} />
      </span>
    );
  }
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  return (
    <span title={user.name} className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", ring && "ring-2 ring-panel")}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(140deg, ${user.avatar_color}, color-mix(in oklab, ${user.avatar_color} 70%, black))` }}>
      {initials}
    </span>
  );
}
export function AvatarStack({ users, max = 4, size = 22 }: { users: (User | undefined)[]; max?: number; size?: number }) {
  const list = users.filter(Boolean) as User[];
  return (
    <span className="flex items-center -space-x-1.5">
      {list.slice(0, max).map((u) => <Avatar key={u.id} user={u} size={size} ring />)}
      {list.length > max && <span className="inline-flex items-center justify-center rounded-full bg-active text-[10px] font-medium text-muted ring-2 ring-panel" style={{ width: size, height: size }}>+{list.length - max}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ pastilles
export function Chip({ children, tone = "muted", className, icon }: { children: ReactNode; tone?: "muted" | "danger" | "warning" | "success" | "ai" | "info"; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12px] font-medium",
      tone === "muted" && "bg-hover text-muted",
      tone === "danger" && "bg-danger-soft text-danger",
      tone === "warning" && "bg-warning-soft text-warning",
      tone === "success" && "bg-success-soft text-success",
      tone === "info" && "bg-info-soft text-info",
      tone === "ai" && "bg-ai-soft text-ai-fg", className)}>
      {icon}{children}
    </span>
  );
}

const ICONS: Record<string, typeof Rocket> = { rocket: Rocket, smartphone: Smartphone, megaphone: Megaphone, globe: Globe, lock: Lock, target: Target, folder: Folder, brain: Brain, users: Users };
export const PROJECT_ICONS = Object.keys(ICONS);
export function ProjectIcon({ icon, color, size = 22 }: { icon: string; color: string; size?: number }) {
  const I = ICONS[icon] ?? Folder;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[7px]" style={{ width: size, height: size, background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}>
      <I style={{ width: size * 0.58, height: size * 0.58 }} strokeWidth={2} />
    </span>
  );
}

export function ProgressRing({ value, size = 36, stroke = 3.5, color = "var(--fg)" }: { value: number; size?: number; stroke?: number; color?: string }) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} style={{ transition: "stroke-dashoffset 600ms cubic-bezier(.2,.8,.2,1)" }} />
    </svg>
  );
}

export function Checkbox({ checked, onChange, size = 18, label }: { checked: boolean; onChange: (v: boolean) => void; size?: number; label?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label ?? (checked ? "Marquer non terminée" : "Marquer terminée")}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={cn("group/cb inline-flex shrink-0 items-center justify-center rounded-full border transition-all duration-200",
        checked ? "border-success bg-success text-white" : "border-line-strong text-transparent hover:border-success hover:text-success")}
      style={{ width: size, height: size }}>
      <Check style={{ width: size * 0.6, height: size * 0.6 }} strokeWidth={3} />
    </button>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <p className="font-serif text-[22px] leading-tight text-fg">{title}</p>
      {children && <p className="max-w-sm text-[13px] text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ menus, popovers, dialogues, infobulles
export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export function MenuContent({ children, align = "start", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} collisionPadding={12}
        className={cn("z-50 min-w-[200px] overflow-hidden rounded-xl border border-line bg-raised p-1 shadow-lg data-[state=open]:animate-in", className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}
export function MenuItem({ children, onSelect, icon, danger, right }: { children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; right?: ReactNode }) {
  return (
    <DM.Item onSelect={onSelect}
      className={cn("flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none data-[highlighted]:bg-hover", danger ? "text-danger" : "text-fg")}>
      {icon && <span className="flex w-4 justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {right}
    </DM.Item>
  );
}
export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <DM.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{children}</DM.Label>;

export const Popover = PO.Root;
export const PopoverTrigger = PO.Trigger;
export function PopoverContent({ children, className, align = "start" }: { children: ReactNode; className?: string; align?: "start" | "end" | "center" }) {
  return (
    <PO.Portal>
      <PO.Content align={align} sideOffset={6} collisionPadding={12} className={cn("z-50 rounded-xl border border-line bg-raised p-1 shadow-lg outline-none", className)}>
        {children}
      </PO.Content>
    </PO.Portal>
  );
}
export const PopoverClose = PO.Close;

export function Dialog({ open, onOpenChange, title, description, children, width = 560, footer }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode;
}) {
  return (
    <DI.Root open={open} onOpenChange={onOpenChange}>
      <DI.Portal>
        <DI.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] dark:bg-black/60" />
        <DI.Content className="fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-24px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-lg outline-none"
          style={{ maxWidth: width }}>
          <div className="flex items-start gap-3 border-b border-line px-5 pb-3.5 pt-4">
            <div className="min-w-0 flex-1">
              <DI.Title className="text-[15px] font-semibold">{title}</DI.Title>
              {description ? <DI.Description className="mt-0.5 text-[13px] text-muted">{description}</DI.Description> : <DI.Description className="sr-only">{String(title)}</DI.Description>}
            </div>
            <DI.Close asChild><IconButton label="Fermer" size="sm"><X className="size-4" /></IconButton></DI.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-bg/50 px-5 py-3">{footer}</div>}
        </DI.Content>
      </DI.Portal>
    </DI.Root>
  );
}

export const TooltipProvider = TT.Provider;
export function Tip({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TT.Root delayDuration={350}>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md bg-fg px-2 py-1 text-[12px] text-bg shadow-md">{label}</TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}

// ------------------------------------------------------------------ Markdown minimal (gras, listes, code)
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const inline = (s: string, k: string | number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`|#\d+|@\p{L}+)/gu);
    return <span key={k}>{parts.map((p, i) => {
      if (/^\*\*.+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
      if (/^`.+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>;
      if (/^#\d+$/.test(p)) return <span key={i} className="font-mono text-[0.92em] text-ai-fg">{p}</span>;
      if (/^@\p{L}+$/u.test(p)) return <span key={i} className="rounded bg-info-soft px-0.5 font-medium text-info">{p}</span>;
      return p;
    })}</span>;
  };
  const flush = () => { if (list.length) { blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l, i)}</li>)}</ul>); list = []; } };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) { list.push(m[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""), 0)}</p>);
  }
  flush();
  return <div className={cn("prose-ai", className)}>{blocks}</div>;
}
