"use client";

/**
 * src/app/(app)/billing/_components/checkout-button.tsx
 *
 * Interactive "Upgrade to Premium" button.
 * Calls POST /api/billing/checkout → receives Stripe Checkout URL → redirects.
 */

import { useState, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckoutButtonProps {
  readonly className?: string;
}

export function CheckoutButton({ className }: CheckoutButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const handleUpgrade = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });

      if (res.status === 409) {
        setError("You're already on the Premium plan.");
        return;
      }

      if (!res.ok) {
        const body = await res.text();
        let message = `Request failed (${res.status})`;
        try {
          const json = JSON.parse(body) as { error?: string };
          if (typeof json.error === "string" && json.error.length > 0) {
            message = json.error;
          }
        } catch {
          // HTML error page — keep status code message
        }
        setError(message);
        return;
      }

      const { url } = (await res.json()) as { url: string };

      if (typeof url !== "string" || url.trim().length === 0) {
        setError("Invalid checkout response. Please try again.");
        return;
      }

      // Hand off to Stripe's hosted checkout page
      window.location.href = url;
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      // Keep loading if redirecting (don't flash button back before navigation)
      if (window.location.href.includes("/billing")) {
        setIsLoading(false);
      }
    }
  }, []);

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={handleUpgrade}
        disabled={isLoading}
        className={cn(
          "group relative w-full overflow-hidden rounded-xl px-6 py-3.5",
          "bg-violet-600 text-white text-sm font-semibold",
          "shadow-[0_0_0_1px_rgba(124,58,237,0.5),0_8px_32px_rgba(124,58,237,0.3)]",
          "transition-all duration-200",
          "hover:bg-violet-500 hover:shadow-[0_0_0_1px_rgba(124,58,237,0.6),0_12px_40px_rgba(124,58,237,0.4)] hover:-translate-y-[1px]",
          "active:translate-y-0 active:shadow-none active:scale-[0.98]",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        {/* Shimmer sweep on hover */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full"
        />

        <span className="relative flex items-center justify-center gap-2">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {isLoading ? "Opening checkout…" : "Upgrade to Premium"}
        </span>
      </button>

      {error !== null && (
        <p className="text-center text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
