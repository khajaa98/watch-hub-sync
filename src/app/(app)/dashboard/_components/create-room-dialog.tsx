/**
 * src/app/(app)/dashboard/_components/create-room-dialog.tsx
 *
 * Multi-step room creation dialog.
 *
 * Step 1: Platform + compatibility check
 * Step 2: Room settings (title, max participants, permissions)
 * Step 3: Share — QR code + magic link panel
 *
 * Server interactions:
 *   POST /api/rooms        → creates the room, returns { roomId, inviteUrl }
 *   POST /api/rooms/:id/invite → (re)generates the signed magic link
 *
 * QR code is generated client-side from the invite URL using the `qrcode` pkg.
 */

"use client";

import {
  useState,
  useCallback,
  useTransition,
  useId,
  useEffect,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  QrCode,
  Settings2,
  Globe,
  Users,
} from "lucide-react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CompatibilityChecker,
  type CompatibilityCheckerValue,
  type CompatibilityResult,
} from "@/components/ui/compatibility-checker";
import type { Platform } from "@/types/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoomConfig {
  platform: Platform | null;
  hasInternationalGuests: boolean;
  contentTitle: string;
  contentId: string;
  maxParticipants: number;
  requireApproval: boolean;
  allowChat: boolean;
  allowReactions: boolean;
}

type Step = 1 | 2 | 3;

interface CreatedRoom {
  id: string;
  inviteUrl: string;
  liveKitRoomName: string;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS = [
  { n: 1 as Step, label: "Platform",  icon: Globe },
  { n: 2 as Step, label: "Settings",  icon: Settings2 },
  { n: 3 as Step, label: "Share",     icon: QrCode },
] as const;

function StepIndicator({ current }: { current: Step }) {
  return (
    <nav aria-label="Room creation steps" className="flex items-center gap-2">
      {STEPS.map(({ n, label, icon: Icon }, idx) => {
        const state =
          n < current ? "done" : n === current ? "active" : "pending";
        return (
          <div key={n} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300",
                state === "done"
                  ? "bg-accent/20 text-accent ring-1 ring-accent/30"
                  : state === "active"
                  ? "bg-accent text-white shadow-[0_0_12px_rgba(124,58,237,0.4)]"
                  : "bg-surface text-neutral-600 ring-1 ring-inset ring-white/[0.06]",
              )}
              aria-current={state === "active" ? "step" : undefined}
            >
              {state === "done" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </div>
            <span
              className={cn(
                "hidden text-xs sm:block",
                state === "active"
                  ? "font-medium text-white"
                  : "text-neutral-600",
              )}
            >
              {label}
            </span>
            {idx < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px w-8 transition-colors duration-300",
                  n < current ? "bg-accent/30" : "bg-white/[0.06]",
                )}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// QR display component
// ---------------------------------------------------------------------------

function QRPanel({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      color: { dark: "#FAFAFA", light: "#111111" },
      errorCorrectionLevel: "M",
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [url]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [url]);

  return (
    <div className="flex flex-col items-center gap-6">
      {/* QR code */}
      <div className="rounded-2xl bg-surface p-3 ring-1 ring-inset ring-white/[0.06]">
        {dataUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt="Scan to join the watch session"
            width={192}
            height={192}
            className="rounded-xl"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="h-48 w-48 animate-pulse rounded-xl bg-surface-raised" />
        )}
      </div>

      {/* Companion device hint */}
      <div className="flex items-start gap-2 rounded-xl bg-accent/[0.06] p-3 text-xs text-neutral-400 ring-1 ring-inset ring-accent/10">
        <QrCode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span>
          Scan with a second device (phone/tablet) to use it as your{" "}
          <strong className="text-neutral-300">Companion Remote</strong> — live
          chat and reactions without leaving the video.
        </span>
      </div>

      {/* Invite link */}
      <div className="w-full space-y-2">
        <p className="text-2xs font-medium uppercase tracking-wider text-neutral-600">
          Or share invite link
        </p>
        <div className="flex items-center gap-2 rounded-xl bg-surface p-3 ring-1 ring-inset ring-white/[0.06]">
          <p className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
            {url}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopy}
            aria-label={copied ? "Copied!" : "Copy invite link"}
            className="shrink-0"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </div>
        <p className="text-2xs text-neutral-700">
          Link expires in 48 hours. New guests need to join before it's closed.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog — rendered from dashboard with AnimatePresence
// ---------------------------------------------------------------------------

interface CreateRoomDialogProps {
  readonly onClose: () => void;
  readonly onCreated: (room: CreatedRoom) => void;
}

export function CreateRoomDialog({ onClose, onCreated }: CreateRoomDialogProps) {
  const formId = useId();
  const [step, setStep] = useState<Step>(1);
  const [isPending, startTransition] = useTransition();

  const [checkerValue, setCheckerValue] = useState<CompatibilityCheckerValue>({
    platform: null,
    hasInternationalGuests: false,
  });
  const [compatResult, setCompatResult] = useState<CompatibilityResult | null>(null);
  const [contentTitle, setContentTitle] = useState("");
  const [contentId, setContentId] = useState("");
  const [maxParticipants, setMaxParticipants] = useState<number>(10);
  const [requireApproval, setRequireApproval] = useState(false);
  const [allowChat, setAllowChat] = useState(true);
  const [allowReactions, setAllowReactions] = useState(true);
  const [createdRoom, setCreatedRoom] = useState<CreatedRoom | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config: RoomConfig = {
    platform: checkerValue.platform,
    hasInternationalGuests: checkerValue.hasInternationalGuests,
    contentTitle,
    contentId,
    maxParticipants,
    requireApproval,
    allowChat,
    allowReactions,
  };

  // ── Step 1 → 2 guard ─────────────────────────────────────────────────────
  const canAdvanceFromStep1 =
    checkerValue.platform !== null &&
    compatResult !== null &&
    compatResult.canProceed;

  // ── Step 2 → 3 (API call) ────────────────────────────────────────────────
  const handleCreateRoom = useCallback(() => {
    if (config.platform === null) return;

    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: config.platform,
            settings: {
              content_id: config.contentId || undefined,
              content_title: config.contentTitle || undefined,
              max_participants: config.maxParticipants,
              has_international_guests: config.hasInternationalGuests,
              require_approval: config.requireApproval,
              allow_chat: config.allowChat,
              allow_reactions: config.allowReactions,
              sync_tolerance_ms: 2000,
            },
          }),
        });

        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? `Request failed: ${res.status}`);
        }

        const data = (await res.json()) as CreatedRoom;
        setCreatedRoom(data);
        onCreated(data);
        setStep(3);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create room. Please try again.",
        );
      }
    });
  }, [config, onCreated]);

  // ── Keyboard shortcut ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog panel */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        className={cn(
          "fixed inset-x-4 top-[50%] z-50 max-w-lg -translate-y-1/2 sm:inset-x-auto sm:left-[50%] sm:-translate-x-1/2",
          "rounded-2xl bg-surface shadow-modal",
          "ring-1 ring-inset ring-white/[0.07]",
          "flex flex-col overflow-hidden",
          "max-h-[90dvh]",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <h2
              id={`${formId}-title`}
              className="text-sm font-semibold text-white"
            >
              Create Watch Room
            </h2>
            <p className="mt-0.5 text-xs text-neutral-600">
              Set up a synchronized streaming session
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-white/[0.05] hover:text-white transition-colors"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="border-b border-white/[0.06] px-5 py-3">
          <StepIndicator current={step} />
        </div>

        {/* Step content — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <AnimatePresence mode="wait" initial={false}>

            {/* ── Step 1: Platform ─────────────────────────────────────── */}
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                <CompatibilityChecker
                  value={checkerValue}
                  onChange={setCheckerValue}
                  onCompatibilityChange={setCompatResult}
                />
              </motion.div>
            )}

            {/* ── Step 2: Settings ─────────────────────────────────────── */}
            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-5"
              >
                {/* Content title */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-neutral-400" htmlFor={`${formId}-title-input`}>
                    What are you watching?{" "}
                    <span className="text-neutral-700">(optional)</span>
                  </label>
                  <input
                    id={`${formId}-title-input`}
                    type="text"
                    placeholder="e.g. Kalki 2898 AD"
                    value={contentTitle}
                    onChange={(e) => setContentTitle(e.target.value)}
                    maxLength={120}
                    className={cn(
                      "w-full rounded-xl bg-surface-raised px-4 py-2.5 text-sm text-white",
                      "ring-1 ring-inset ring-white/[0.08]",
                      "placeholder:text-neutral-700",
                      "focus:outline-none focus:ring-2 focus:ring-accent/50",
                      "transition-shadow duration-150",
                    )}
                  />
                </div>

                {/* Content ID / URL */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-neutral-400" htmlFor={`${formId}-id-input`}>
                    Video URL or ID{" "}
                    <span className="text-neutral-700">(optional)</span>
                  </label>
                  <input
                    id={`${formId}-id-input`}
                    type="text"
                    placeholder="YouTube video ID or URL"
                    value={contentId}
                    onChange={(e) => setContentId(e.target.value)}
                    className={cn(
                      "w-full rounded-xl bg-surface-raised px-4 py-2.5 font-mono text-xs text-neutral-300",
                      "ring-1 ring-inset ring-white/[0.08]",
                      "placeholder:font-sans placeholder:text-neutral-700",
                      "focus:outline-none focus:ring-2 focus:ring-accent/50",
                      "transition-shadow duration-150",
                    )}
                  />
                  <p className="text-2xs text-neutral-700">
                    Used only for room display. The video plays in each guest's own browser tab.
                  </p>
                </div>

                {/* Max participants */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-neutral-400" htmlFor={`${formId}-max-input`}>
                    Max participants
                  </label>
                  <select
                    id={`${formId}-max-input`}
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(Number(e.target.value))}
                    className={cn(
                      "w-full rounded-xl bg-surface-raised px-4 py-2.5 text-sm text-white",
                      "ring-1 ring-inset ring-white/[0.08]",
                      "focus:outline-none focus:ring-2 focus:ring-accent/50",
                      "appearance-none transition-shadow duration-150",
                    )}
                  >
                    {[2, 5, 10, 25, 50].map((n) => (
                      <option key={n} value={n} className="bg-surface-overlay">
                        {n} participants
                      </option>
                    ))}
                  </select>
                </div>

                {/* Toggles */}
                <div className="space-y-2">
                  {[
                    { id: "approval", label: "Require host approval to join", state: requireApproval, set: setRequireApproval },
                    { id: "chat",     label: "Enable chat",                   state: allowChat,       set: setAllowChat },
                    { id: "reactions",label: "Enable emoji reactions",         state: allowReactions,  set: setAllowReactions },
                  ].map(({ id, label, state, set }) => (
                    <div
                      key={id}
                      className="flex items-center justify-between rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-white/[0.06]"
                    >
                      <label
                        htmlFor={`${formId}-toggle-${id}`}
                        className="cursor-pointer text-xs text-neutral-300"
                      >
                        {label}
                      </label>
                      <button
                        id={`${formId}-toggle-${id}`}
                        role="switch"
                        aria-checked={state}
                        onClick={() => set(!state)}
                        className={cn(
                          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-250",
                          state ? "bg-accent" : "bg-white/[0.10]",
                        )}
                      >
                        <motion.span
                          layout
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                          className={cn(
                            "inline-block h-3.5 w-3.5 rounded-full bg-white shadow",
                            state ? "translate-x-[18px]" : "translate-x-[3px]",
                          )}
                          aria-hidden="true"
                        />
                        <span className="sr-only">{label}</span>
                      </button>
                    </div>
                  ))}
                </div>

                {/* Error */}
                {error !== null && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="rounded-xl bg-danger/10 px-4 py-3 text-xs text-danger ring-1 ring-inset ring-danger/20"
                    role="alert"
                  >
                    {error}
                  </motion.p>
                )}
              </motion.div>
            )}

            {/* ── Step 3: Share ─────────────────────────────────────────── */}
            {step === 3 && createdRoom !== null && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-6"
              >
                {/* Success header */}
                <div className="flex flex-col items-center gap-2 text-center">
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.1, type: "spring", stiffness: 400, damping: 20 }}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-ok/10 ring-1 ring-ok/20"
                  >
                    <Check className="h-6 w-6 text-ok" aria-hidden="true" />
                  </motion.div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Room Created!
                    </h3>
                    <p className="text-xs text-neutral-500">
                      Share the QR code or link below to invite guests
                    </p>
                  </div>
                </div>

                <QRPanel url={createdRoom.inviteUrl} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-4">
          {step > 1 && step < 3 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep((s) => (s - 1) as Step)}
              leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
            >
              Back
            </Button>
          ) : (
            <div aria-hidden="true" />
          )}

          {step === 1 && (
            <Button
              size="sm"
              onClick={() => setStep(2)}
              disabled={!canAdvanceFromStep1}
              rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
            >
              Next: Settings
            </Button>
          )}

          {step === 2 && (
            <Button
              size="sm"
              onClick={handleCreateRoom}
              isLoading={isPending}
              leftIcon={<Users className="h-3.5 w-3.5" />}
            >
              Create Room
            </Button>
          )}

          {step === 3 && (
            <Button
              size="sm"
              onClick={onClose}
              rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
            >
              Go to Room
            </Button>
          )}
        </div>
      </motion.div>
    </>
  );
}
