/**
 * src/components/ui/compatibility-checker.tsx
 *
 * Smart Cross-Border Platform Compatibility Checker for Watch Hub Sync.
 *
 * Architecture:
 *   A fully declarative, controlled component. The parent form owns platform
 *   and hasInternationalGuests state; this component renders the compatibility
 *   result matrix and emits changes upward.
 *
 * Compatibility Matrix:
 *   The matrix is a static lookup table keyed by [platform][guestProfile].
 *   "India-locked" platforms (JioHotstar) produce an ERROR result when
 *   international guests are flagged, with a mandatory platform-switch CTA.
 *   "Content-varies" platforms (Netflix, Prime) produce a WARNING.
 *   Universal platforms (YouTube) always produce OK.
 *
 * Motion design:
 *   - Platform card selection: spring scale + glow ring
 *   - International toggle appearance: slide-down + fade
 *   - Result banner: slide-up + fade with exit animation
 *   - Platform switch suggestion: scale-in after 200ms delay
 */

"use client";

import { useCallback, useMemo, useState, useId } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  AlertTriangle,
  CheckCircle2,
  Info,
  ArrowRight,
  Lock,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Platform } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Compatibility Matrix — single source of truth for geo-blocking logic
// ---------------------------------------------------------------------------

type CompatibilitySeverity = "ok" | "warning" | "error";
type GuestProfile = "domestic_only" | "has_international";

interface CompatibilityResult {
  readonly severity: CompatibilitySeverity;
  readonly title: string;
  readonly message: string;
  readonly suggestedPlatform?: Platform;
  readonly canProceed: boolean;
}

interface PlatformMeta {
  readonly id: Platform;
  readonly label: string;
  readonly description: string;
  readonly colorClass: string;   // Tailwind text color class for the platform
  readonly bgClass: string;      // Tailwind bg class for the icon container
  readonly isGeoLocked: boolean; // True = shows lock badge
  readonly lockNote?: string;    // Shown under platform name if geo-locked
}

// Platform registry
const PLATFORMS: PlatformMeta[] = [
  {
    id: "youtube",
    label: "YouTube",
    description: "Free, global. Any content on YouTube.",
    colorClass: "text-red-400",
    bgClass: "bg-red-500/10",
    isGeoLocked: false,
  },
  {
    id: "jiohotstar",
    label: "JioHotstar",
    description: "India's largest OTT — Bollywood, cricket, Disney+.",
    colorClass: "text-blue-400",
    bgClass: "bg-blue-500/10",
    isGeoLocked: true,
    lockNote: "India accounts only",
  },
  {
    id: "netflix",
    label: "Netflix",
    description: "Global availability — library varies by country.",
    colorClass: "text-red-500",
    bgClass: "bg-red-600/10",
    isGeoLocked: false,
  },
  {
    id: "primevideo",
    label: "Prime Video",
    description: "Global availability — library varies by country.",
    colorClass: "text-sky-400",
    bgClass: "bg-sky-500/10",
    isGeoLocked: false,
  },
];

// The compatibility matrix: [platform][guestProfile] → result
const COMPATIBILITY_MATRIX: Record<
  Platform,
  Record<GuestProfile, CompatibilityResult>
> = {
  youtube: {
    domestic_only: {
      severity: "ok",
      title: "YouTube — Globally Compatible",
      message:
        "YouTube is available worldwide without geo-restrictions. All guests can access it from any country.",
      canProceed: true,
    },
    has_international: {
      severity: "ok",
      title: "YouTube — Globally Compatible",
      message:
        "YouTube works in all guest locations. No geo-blocking risk. Your session will work seamlessly.",
      canProceed: true,
    },
  },

  jiohotstar: {
    domestic_only: {
      severity: "ok",
      title: "JioHotstar — All guests in India",
      message:
        "All your guests appear to be in India. JioHotstar will work if everyone has an active subscription.",
      canProceed: true,
    },
    has_international: {
      severity: "error",
      title: "JioHotstar is India-locked",
      message:
        "JioHotstar is only accessible from India. International guests won't be able to play content and will see access errors. Switch to YouTube for a session that works globally.",
      suggestedPlatform: "youtube",
      canProceed: false,
    },
  },

  netflix: {
    domestic_only: {
      severity: "ok",
      title: "Netflix — All guests in India",
      message:
        "Netflix is available to all your guests. Note: guests must have their own active subscription.",
      canProceed: true,
    },
    has_international: {
      severity: "warning",
      title: "Netflix — Content library may differ",
      message:
        "Netflix is globally available, but the specific title you choose may not exist in your guests' regions. Confirm the title is available in all countries before starting.",
      canProceed: true,
    },
  },

  primevideo: {
    domestic_only: {
      severity: "ok",
      title: "Prime Video — All guests in India",
      message:
        "Prime Video is available to all your guests. Each guest needs their own Prime subscription.",
      canProceed: true,
    },
    has_international: {
      severity: "warning",
      title: "Prime Video — Content may vary by region",
      message:
        "Prime Video operates globally but licensing differs per country. Verify your selected title is available in all guest regions before creating the room.",
      canProceed: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const SPRING = { type: "spring", stiffness: 400, damping: 30 } as const;

const fadeSlideUp = {
  initial:  { opacity: 0, y: 10 },
  animate:  { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit:     { opacity: 0, y: -6, transition: { duration: 0.15, ease: "easeIn" } },
};

const fadeSlideDown = {
  initial:  { opacity: 0, y: -8, height: 0 },
  animate:  { opacity: 1, y: 0, height: "auto", transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit:     { opacity: 0, y: -4, height: 0, transition: { duration: 0.18, ease: "easeIn" } },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Platform icon — letter avatar with platform color
function PlatformIcon({
  platform,
  size = "md",
}: {
  platform: PlatformMeta;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "h-7 w-7 text-xs" : "h-10 w-10 text-sm";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-bold",
        dim,
        platform.bgClass,
        platform.colorClass,
      )}
      aria-hidden="true"
    >
      {platform.label[0]}
    </span>
  );
}

// Compatibility result banner
function ResultBanner({
  result,
  onSwitchPlatform,
}: {
  result: CompatibilityResult;
  onSwitchPlatform?: (platform: Platform) => void;
}) {
  const suggestedMeta =
    result.suggestedPlatform !== undefined
      ? PLATFORMS.find((p) => p.id === result.suggestedPlatform)
      : undefined;

  const styles: Record<
    CompatibilitySeverity,
    { wrapper: string; icon: React.ElementType; iconClass: string }
  > = {
    ok: {
      wrapper: "bg-ok/[0.07] ring-ok/20 text-ok",
      icon: CheckCircle2,
      iconClass: "text-ok",
    },
    warning: {
      wrapper: "bg-warn/[0.07] ring-warn/20 text-warn",
      icon: AlertTriangle,
      iconClass: "text-warn",
    },
    error: {
      wrapper: "bg-danger/[0.07] ring-danger/20 text-danger",
      icon: AlertTriangle,
      iconClass: "text-danger",
    },
  };

  const s = styles[result.severity];
  const Icon = s.icon;

  return (
    <motion.div
      {...fadeSlideUp}
      className={cn(
        "rounded-xl p-4 ring-1 ring-inset",
        s.wrapper,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex gap-3">
        <Icon
          className={cn("mt-0.5 h-4 w-4 shrink-0", s.iconClass)}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug">{result.title}</p>
          <p className="mt-1 text-xs leading-relaxed opacity-80">
            {result.message}
          </p>

          {/* Switch platform CTA — only on error with a suggestion */}
          {result.severity === "error" &&
            suggestedMeta !== undefined &&
            onSwitchPlatform !== undefined && (
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.2, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="mt-3"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (result.suggestedPlatform !== undefined) {
                      onSwitchPlatform(result.suggestedPlatform);
                    }
                  }}
                  rightIcon={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
                  leftIcon={
                    <PlatformIcon
                      platform={suggestedMeta}
                      size="sm"
                    />
                  }
                  className="border-0 bg-white/[0.08] text-white ring-1 ring-inset ring-white/10 hover:bg-white/[0.13]"
                >
                  Switch to {suggestedMeta.label}
                </Button>
              </motion.div>
            )}
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface CompatibilityCheckerValue {
  platform: Platform | null;
  hasInternationalGuests: boolean;
}

export interface CompatibilityCheckerProps {
  readonly value: CompatibilityCheckerValue;
  readonly onChange: (value: CompatibilityCheckerValue) => void;
  /**
   * Fires whenever the computed compatibility result changes.
   * Use to gate the room creation submit button.
   */
  readonly onCompatibilityChange?: (result: CompatibilityResult | null) => void;
  readonly className?: string;
}

export function CompatibilityChecker({
  value,
  onChange,
  onCompatibilityChange,
  className,
}: CompatibilityCheckerProps) {
  const toggleId = useId();

  // ── Derived state ─────────────────────────────────────────────────────────
  const selectedPlatformMeta = useMemo(
    () =>
      value.platform !== null
        ? (PLATFORMS.find((p) => p.id === value.platform) ?? null)
        : null,
    [value.platform],
  );

  const showInternationalToggle =
    selectedPlatformMeta !== null && selectedPlatformMeta.isGeoLocked;

  const compatibilityResult = useMemo<CompatibilityResult | null>(() => {
    if (value.platform === null) return null;
    const matrix = COMPATIBILITY_MATRIX[value.platform];
    const profile: GuestProfile = value.hasInternationalGuests
      ? "has_international"
      : "domestic_only";
    return matrix[profile];
  }, [value.platform, value.hasInternationalGuests]);

  // Notify parent when result changes
  const prevResultRef = useState<CompatibilityResult | null>(null);
  if (
    onCompatibilityChange !== undefined &&
    compatibilityResult !== prevResultRef[0]
  ) {
    prevResultRef[1](compatibilityResult);
    onCompatibilityChange(compatibilityResult);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handlePlatformSelect = useCallback(
    (platformId: Platform) => {
      // Selecting a new platform resets the international toggle.
      // If the new platform isn't geo-locked, hasInternationalGuests has no meaning.
      const meta = PLATFORMS.find((p) => p.id === platformId);
      const resetInternational = meta?.isGeoLocked !== true;
      onChange({
        platform: platformId,
        hasInternationalGuests: resetInternational
          ? false
          : value.hasInternationalGuests,
      });
    },
    [onChange, value.hasInternationalGuests],
  );

  const handleToggleInternational = useCallback(
    (checked: boolean) => {
      onChange({ ...value, hasInternationalGuests: checked });
    },
    [onChange, value],
  );

  const handleSwitchPlatform = useCallback(
    (platform: Platform) => {
      onChange({ platform, hasInternationalGuests: false });
    },
    [onChange],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={cn("space-y-4", className)}>

      {/* Section label */}
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Streaming Platform
        </h3>
      </div>

      {/* Platform grid */}
      <div
        role="radiogroup"
        aria-label="Select streaming platform"
        className="grid grid-cols-2 gap-2.5 sm:grid-cols-4"
      >
        {PLATFORMS.map((platform) => {
          const isSelected = value.platform === platform.id;

          return (
            <motion.button
              key={platform.id}
              role="radio"
              aria-checked={isSelected}
              aria-label={`${platform.label}${platform.isGeoLocked ? " — India only" : ""}`}
              onClick={() => handlePlatformSelect(platform.id)}
              whileTap={{ scale: 0.96 }}
              transition={SPRING}
              className={cn(
                "group relative flex flex-col items-start gap-2 rounded-xl p-3 text-left",
                "ring-1 ring-inset transition-all duration-200",
                isSelected
                  ? [
                      "bg-accent/[0.08] ring-accent/40",
                      "shadow-[0_0_0_1px_rgba(124,58,237,0.15)]",
                    ].join(" ")
                  : "bg-surface ring-white/[0.06] hover:bg-surface-raised hover:ring-white/[0.10]",
              )}
            >
              {/* Platform icon */}
              <PlatformIcon platform={platform} />

              {/* Platform info */}
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-xs font-semibold leading-tight transition-colors",
                    isSelected ? "text-white" : "text-neutral-300 group-hover:text-white",
                  )}
                >
                  {platform.label}
                </p>
                {platform.isGeoLocked && (
                  <span className="mt-0.5 inline-flex items-center gap-0.5 text-2xs text-neutral-600">
                    <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                    {platform.lockNote}
                  </span>
                )}
              </div>

              {/* Selected ring animation */}
              {isSelected && (
                <motion.span
                  layoutId="platform-ring"
                  className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent/60"
                  transition={SPRING}
                  aria-hidden="true"
                />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* Platform description */}
      <AnimatePresence mode="wait">
        {selectedPlatformMeta !== null && (
          <motion.p
            key={selectedPlatformMeta.id + "_desc"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-start gap-2 text-xs text-neutral-500"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {selectedPlatformMeta.description}
          </motion.p>
        )}
      </AnimatePresence>

      {/* International guests toggle — only for geo-locked platforms */}
      <AnimatePresence>
        {showInternationalToggle && (
          <motion.div {...fadeSlideDown} className="overflow-hidden">
            <div
              className={cn(
                "flex items-center justify-between gap-4 rounded-xl p-4",
                "bg-surface ring-1 ring-inset ring-white/[0.06]",
              )}
            >
              <label
                htmlFor={toggleId}
                className="flex min-w-0 cursor-pointer flex-col gap-0.5"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-200">
                  <Users className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
                  International guests?
                </span>
                <span className="text-xs text-neutral-600">
                  Do any of your invited guests reside outside India?
                </span>
              </label>

              {/* Toggle switch */}
              <button
                id={toggleId}
                role="switch"
                aria-checked={value.hasInternationalGuests}
                onClick={() =>
                  handleToggleInternational(!value.hasInternationalGuests)
                }
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full",
                  "ring-1 ring-inset transition-colors duration-250",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
                  value.hasInternationalGuests
                    ? "bg-accent ring-accent/30"
                    : "bg-white/[0.06] ring-white/10",
                )}
              >
                <motion.span
                  layout
                  transition={SPRING}
                  className={cn(
                    "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm",
                    value.hasInternationalGuests
                      ? "translate-x-6"
                      : "translate-x-1",
                  )}
                  aria-hidden="true"
                />
                <span className="sr-only">
                  {value.hasInternationalGuests
                    ? "International guests included"
                    : "India-only guests"}
                </span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compatibility result banner */}
      <AnimatePresence mode="wait">
        {compatibilityResult !== null && (
          <motion.div key={`${String(value.platform)}_${String(value.hasInternationalGuests)}`}>
            <ResultBanner
              result={compatibilityResult}
              onSwitchPlatform={handleSwitchPlatform}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-export the result type for parent forms
// ---------------------------------------------------------------------------
export type { CompatibilityResult, CompatibilitySeverity };
