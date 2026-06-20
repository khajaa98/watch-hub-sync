/**
 * src/components/layout/app-nav.tsx
 *
 * Top navigation bar for authenticated app routes.
 * Client Component — handles sign-out and mobile menu state.
 */

"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid,
  Tv2,
  CreditCard,
  LogOut,
  Crown,
  Menu,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { SubscriptionTier } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppNavProps {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly tier: SubscriptionTier;
}

// ---------------------------------------------------------------------------
// Nav link definitions
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/rooms",     label: "Rooms",     icon: Tv2 },
  { href: "/billing",   label: "Billing",   icon: CreditCard },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppNav({ userId: _userId, displayName, avatarUrl, tier }: AppNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }, [router]);

  const initials = displayName
    ? displayName
        .split(" ")
        .map((w) => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <header
      className={cn(
        "sticky top-0 z-40 h-[var(--nav-height)]",
        "border-b border-white/[0.06] bg-canvas/80 backdrop-blur-xl",
      )}
    >
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 no-tap"
          aria-label="Watch Hub Sync dashboard"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/20 text-xs font-bold text-accent ring-1 ring-inset ring-accent/20">
            W
          </span>
          <span className="hidden text-sm font-semibold text-neutral-200 sm:inline">
            Watch Hub Sync
          </span>
        </Link>

        {/* Desktop navigation */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const isActive = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-all duration-150",
                  isActive
                    ? "bg-white/[0.08] text-white"
                    : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-3">
          {/* Tier badge */}
          {tier === "premium" && (
            <span className="hidden items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-2xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20 sm:flex">
              <Crown className="h-2.5 w-2.5" aria-hidden="true" />
              Premium
            </span>
          )}

          {/* Avatar + sign-out */}
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/20 ring-1 ring-inset ring-white/10"
              aria-hidden="true"
            >
              {avatarUrl !== null ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="text-xs font-semibold text-accent">
                  {initials}
                </span>
              )}
            </div>

            <button
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-neutral-200 disabled:opacity-50 md:flex"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/[0.05] hover:text-white md:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Menu className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile nav drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-0 top-[var(--nav-height)] border-b border-white/[0.06] bg-canvas/95 backdrop-blur-xl md:hidden"
          >
            <nav className="flex flex-col gap-1 p-3">
              {NAV_LINKS.map(({ href, label, icon: Icon }) => {
                const isActive = pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors",
                      isActive
                        ? "bg-white/[0.08] text-white"
                        : "text-neutral-400 hover:bg-white/[0.05] hover:text-white",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </Link>
                );
              })}
              <div className="my-1 border-t border-white/[0.06]" />
              <button
                onClick={handleSignOut}
                disabled={isSigningOut}
                className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-neutral-200 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign Out
              </button>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
