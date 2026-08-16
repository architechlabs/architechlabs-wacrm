import { cn } from "@/lib/utils";

interface BrandLockupProps {
  className?: string;
  compact?: boolean;
  align?: "start" | "center";
}

/**
 * Text-only product lockup.
 *
 * The repository does not contain an official Architech Labs logo asset, so
 * this deliberately uses typography and a simple accent rule rather than
 * inventing a substitute mark.
 */
export function BrandLockup({
  className,
  compact = false,
  align = "start",
}: BrandLockupProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5",
        align === "center" && "justify-center",
        className,
      )}
      aria-label="Architech Labs — WhatsApp Desk"
    >
      <span
        className={cn(
          "w-0.5 shrink-0 rounded-full bg-primary",
          compact ? "h-7" : "h-9",
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate font-semibold uppercase leading-none tracking-[0.12em] text-foreground",
            compact ? "text-xs" : "text-[13px]",
          )}
        >
          Architech Labs
        </span>
        <span
          className={cn(
            "mt-1 truncate font-medium leading-none text-muted-foreground",
            compact ? "text-[10px]" : "text-[11px]",
          )}
        >
          WhatsApp Desk
        </span>
      </span>
    </div>
  );
}
