/**
 * src/components/ui/badge.tsx
 *
 * Status and label badge primitive.
 * Variants: default | success | warning | danger | accent | premium | muted.
 */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset",
  {
    variants: {
      variant: {
        default:
          "bg-white/[0.06] text-neutral-300 ring-white/10",
        success:
          "bg-ok/10 text-ok ring-ok/20",
        warning:
          "bg-warn/10 text-warn ring-warn/20",
        danger:
          "bg-danger/10 text-danger ring-danger/20",
        accent:
          "bg-accent/10 text-accent ring-accent/20",
        premium:
          "bg-amber-500/10 text-amber-400 ring-amber-500/20",
        muted:
          "bg-transparent text-neutral-600 ring-white/[0.04]",
        // Platform-specific
        youtube:
          "bg-red-600/10 text-red-400 ring-red-600/20",
        jiohotstar:
          "bg-blue-600/10 text-blue-400 ring-blue-600/20",
        netflix:
          "bg-red-700/10 text-red-500 ring-red-700/20",
        primevideo:
          "bg-sky-600/10 text-sky-400 ring-sky-600/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  readonly dot?: boolean;
}

function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            variant === "success"   && "bg-ok",
            variant === "warning"   && "bg-warn",
            variant === "danger"    && "bg-danger",
            variant === "accent"    && "bg-accent",
            variant === "premium"   && "bg-amber-400",
            (!variant || variant === "default" || variant === "muted") && "bg-neutral-500",
          )}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
