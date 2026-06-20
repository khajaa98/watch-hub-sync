/**
 * src/components/ui/button.tsx
 *
 * Core Button primitive for WatchHubSync.
 * Variants: primary | secondary | ghost | danger | warning | outline.
 * Sizes: xs | sm | md | lg | xl | icon | icon-sm.
 *
 * Renders a loading spinner in place of left icon when isLoading=true.
 * Uses CVA for compile-time class variant resolution.
 */

"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2",
    "whitespace-nowrap font-medium",
    "ring-offset-canvas transition-all",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-40",
    "select-none no-tap",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-accent text-white",
          "shadow-[0_0_0_1px_rgba(124,58,237,0.4),inset_0_1px_0_rgba(255,255,255,0.08)]",
          "hover:bg-accent-hover",
          "active:scale-[0.97] active:shadow-none",
        ].join(" "),

        secondary: [
          "bg-white/[0.04] text-neutral-200",
          "ring-1 ring-inset ring-white/10",
          "hover:bg-white/[0.08] hover:text-white",
          "active:scale-[0.98]",
        ].join(" "),

        ghost: [
          "text-neutral-400",
          "hover:bg-white/[0.05] hover:text-white",
        ].join(" "),

        danger: [
          "bg-red-500/10 text-red-400",
          "ring-1 ring-inset ring-red-500/20",
          "hover:bg-red-500/[0.15] hover:text-red-300",
        ].join(" "),

        warning: [
          "bg-amber-500/10 text-amber-300",
          "ring-1 ring-inset ring-amber-500/20",
          "hover:bg-amber-500/[0.15]",
        ].join(" "),

        outline: [
          "border border-white/10 bg-transparent text-neutral-300",
          "hover:bg-white/[0.05] hover:border-white/20 hover:text-white",
        ].join(" "),

        "accent-subtle": [
          "bg-accent/10 text-accent",
          "ring-1 ring-inset ring-accent/20",
          "hover:bg-accent/15 hover:text-violet-300",
        ].join(" "),
      },

      size: {
        xs:       "h-7 rounded-md px-2.5 text-xs gap-1",
        sm:       "h-8 rounded-lg px-3 text-xs",
        md:       "h-10 rounded-lg px-4 text-sm",
        lg:       "h-12 rounded-xl px-6 text-base",
        xl:       "h-14 rounded-xl px-8 text-base",
        icon:     "h-10 w-10 rounded-lg",
        "icon-sm": "h-8 w-8 rounded-md",
        "icon-lg": "h-12 w-12 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly isLoading?: boolean;
  readonly leftIcon?: React.ReactNode;
  readonly rightIcon?: React.ReactNode;
  /** Renders as an anchor tag — useful for inline text links */
  readonly asChild?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled === true || isLoading}
        aria-disabled={disabled === true || isLoading}
        {...props}
      >
        {/* Left slot: spinner overrides icon during loading */}
        {isLoading ? (
          <Loader2
            className="h-4 w-4 animate-spin shrink-0"
            aria-hidden="true"
          />
        ) : leftIcon !== undefined ? (
          <span className="shrink-0" aria-hidden="true">
            {leftIcon}
          </span>
        ) : null}

        {children}

        {/* Right slot: hidden during loading to prevent width shift */}
        {!isLoading && rightIcon !== undefined ? (
          <span className="shrink-0" aria-hidden="true">
            {rightIcon}
          </span>
        ) : null}
      </button>
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
