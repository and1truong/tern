import type { ReactNode } from "react";
import { X } from "lucide-react";

export type NoticeVariant = "muted" | "success" | "warning" | "error" | "claude";

// Variant → CSS-var color used for the left accent bar and the title text.
// `muted` has no accent: neutral border edge, plain --text title.
const VARIANT_COLOR: Record<NoticeVariant, string | null> = {
  muted: null,
  success: "var(--green)",
  warning: "var(--orange)",
  error: "var(--red)",
  claude: "var(--accent)",
};

export interface NoticeProps {
  variant: NoticeVariant;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  onClick?: () => void;
  /** card = rounded standalone (toasts); bar = flush docked (border-b);
   *  inline = transparent, accent-bar + text only (modal one-offs). */
  layout?: "card" | "bar" | "inline";
  /** monospace + pre-wrap message body (git error). */
  mono?: boolean;
  className?: string;
}

// Iconless notification box. Color carries the signal: a 3px left accent bar
// plus a variant-colored title. Neutral --panel background throughout.
export default function Notice({
  variant,
  title,
  children,
  actions,
  onDismiss,
  onClick,
  layout = "card",
  mono = false,
  className = "",
}: NoticeProps) {
  const color = VARIANT_COLOR[variant];
  const SHAPE: Record<NonNullable<NoticeProps["layout"]>, string> = {
    card: "rounded-xl border border-[var(--border-2)] shadow-lg bg-[var(--panel)] p-3",
    bar: "border-b border-[var(--border)] bg-[var(--panel)] p-3",
    inline: "", // transparent, no chrome — padding comes from className
  };
  const clickable = onClick ? "cursor-pointer hover:bg-[var(--hover)]" : "";

  return (
    <div
      onClick={onClick}
      style={color ? { borderLeft: `3px solid ${color}` } : undefined}
      className={`group flex items-start gap-2.5 ${SHAPE[layout]} ${clickable} ${className}`}
    >
      <div className="min-w-0 flex-1">
        {title && (
          <div
            className="font-semibold truncate"
            style={{ color: color ?? "var(--text)" }}
          >
            {title}
          </div>
        )}
        {children != null && (
          <div
            className={`mt-0.5 text-[var(--muted)] ${mono ? "mono whitespace-pre-wrap break-words" : ""}`}
          >
            {children}
          </div>
        )}
        {actions && <div className="mt-2 flex items-center gap-2">{actions}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          title="Dismiss"
          aria-label="Dismiss"
          className="flex-none grid h-5 w-5 place-items-center rounded text-[var(--faint)] hover:bg-[var(--active)] hover:text-[var(--text)]"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
