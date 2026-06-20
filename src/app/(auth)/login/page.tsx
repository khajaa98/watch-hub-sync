/**
 * src/app/(auth)/login/page.tsx
 *
 * WatchHubSync — Cinematic login card.
 *
 * ┌─ Presentation ──────────────────────────────────────────────────────────┐
 *  • Glassmorphism card: bg-black/40 backdrop-blur-2xl border-white/10      │
 *  • Framer Motion: card fades in + slides up (y:20→0) over 0.6s           │
 *  • Inputs: bg-white/5 with violet focus ring                              │
 *  • CTA: stark white button, inverted text, hover lift                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Auth logic (DO NOT MODIFY) ────────────────────────────────────────────┐
 *  • Email magic link via supabase.auth.signInWithOtp()                     │
 *  • PKCE redirect to /api/auth/callback                                    │
 *  • FIDO2 Passkey via navigator.credentials.get()                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

"use client";

import {
  useState,
  useCallback,
  useEffect,
  useTransition,
  useId,
  Suspense,
  type FormEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mail,
  Fingerprint,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthStep =
  | { id: "idle" }
  | { id: "loading"; method: "magic-link" | "passkey" | "google" }
  | { id: "sent"; email: string }
  | { id: "passkey-pending" }
  | { id: "error"; message: string; method: "magic-link" | "passkey" | "google" };

// ---------------------------------------------------------------------------
// Animation presets
// ---------------------------------------------------------------------------

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

const panelVariants = {
  enter:  { opacity: 0, y: 10, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
  center: { opacity: 1, y: 0,  transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } },
  exit:   { opacity: 0, y: -8, transition: { duration: 0.18, ease: "easeIn" } },
};

// ---------------------------------------------------------------------------
// Google "G" icon — inline SVG (lucide-react has no Google icon)
// ---------------------------------------------------------------------------

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Reusable divider
// ---------------------------------------------------------------------------

function OrDivider() {
  return (
    <div className="relative my-5">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-white/[0.07]" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-transparent px-3 text-[11px] uppercase tracking-widest text-zinc-700">
          or
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable input primitive (presentation only)
// ---------------------------------------------------------------------------

function CinemaInput({
  id,
  type = "text",
  placeholder,
  value,
  onChange,
  disabled,
  autoFocus,
  icon: Icon,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  id: string;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  icon: React.ElementType;
  "aria-describedby"?: string;
  "aria-invalid"?: "true" | undefined;
}) {
  return (
    <div className="relative">
      <Icon className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500 transition-colors duration-150 peer-focus:text-violet-400" aria-hidden="true" />
      <input
        id={id}
        type={type}
        autoComplete={type === "email" ? "email" : undefined}
        autoFocus={autoFocus}
        required
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cn(
          "peer w-full rounded-xl bg-white/5 py-3 pl-10 pr-4",
          "text-sm text-white placeholder:text-zinc-600",
          "border border-white/10",
          "outline-none ring-0",
          "transition-all duration-150",
          "focus:border-violet-500/40 focus:bg-white/[0.07] focus:ring-2 focus:ring-violet-500/30",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function SentPanel({ email, onRetry }: { email: string; onRetry: () => void }) {
  return (
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
      className="flex flex-col items-center gap-6 py-4 text-center"
    >
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, ...SPRING }}
        className="relative flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/25"
      >
        <CheckCircle2 className="h-7 w-7 text-emerald-400" />
        <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-emerald-500/20 [animation-duration:2.5s]" />
      </motion.div>

      <div className="space-y-2">
        <h2 className="text-[15px] font-semibold tracking-tight text-white">
          Check your inbox
        </h2>
        <p className="text-sm text-zinc-500">We sent a magic link to</p>
        <p className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white">
          {email}
        </p>
        <p className="text-xs text-zinc-600">
          Expires in 60 minutes · check spam if you don't see it
        </p>
      </div>

      <button
        onClick={onRetry}
        className="text-xs text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-400"
      >
        Try a different email
      </button>
    </motion.div>
  );
}

function PasskeyPendingPanel() {
  return (
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
      className="flex flex-col items-center gap-6 py-4 text-center"
    >
      <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-violet-500/10 ring-1 ring-violet-500/25">
        <motion.div
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Fingerprint className="h-7 w-7 text-violet-400" />
        </motion.div>
        <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-violet-500/20 [animation-duration:2.5s]" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-white">
          Verifying passkey
        </h2>
        <p className="text-sm text-zinc-500">
          Follow the prompt on your device
        </p>
      </div>
    </motion.div>
  );
}

function LoginForm({
  step,
  onMagicLink,
  onPasskey,
  onGoogle,
  hasPasskeySupport,
  formId,
}: {
  step: AuthStep;
  onMagicLink: (email: string) => void;
  onPasskey: () => void;
  onGoogle: () => void;
  hasPasskeySupport: boolean;
  formId: string;
}) {
  const [email, setEmail] = useState("");
  const isLoading        = step.id === "loading";
  const errorMessage     = step.id === "error" ? step.message : null;
  const isMagicLoading   = step.id === "loading" && step.method === "magic-link";
  const isPasskeyLoading = step.id === "loading" && step.method === "passkey";
  const isGoogleLoading  = step.id === "loading" && step.method === "google";

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = email.trim().toLowerCase();
      if (trimmed.length === 0) return;
      onMagicLink(trimmed);
    },
    [email, onMagicLink],
  );

  return (
    <motion.div variants={panelVariants} initial="enter" animate="center" exit="exit">
      {/* ── Google OAuth button ── */}
      <button
        type="button"
        onClick={onGoogle}
        disabled={isLoading}
        aria-label="Continue with Google"
        className={cn(
          "w-full flex items-center justify-center gap-2.5 rounded-xl py-3 text-sm font-medium",
          "border border-white/10 bg-white/[0.03]",
          "text-zinc-200 transition-all duration-150",
          "hover:border-white/20 hover:bg-white/[0.08]",
          "active:scale-[0.99]",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        {isGoogleLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        ) : (
          <GoogleIcon className="h-4 w-4" />
        )}
        {isGoogleLoading ? "Redirecting…" : "Continue with Google"}
      </button>

      <OrDivider />

      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-3"
        noValidate
        aria-label="Sign in with email"
      >
        {/* Email label */}
        <div className="space-y-1.5">
          <label
            htmlFor={`${formId}-email`}
            className="block text-xs font-medium text-zinc-500"
          >
            Email address
          </label>
          <CinemaInput
            id={`${formId}-email`}
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={setEmail}
            disabled={isLoading}
            autoFocus
            icon={Mail}
            {...(errorMessage !== null
              ? { "aria-describedby": `${formId}-error`, "aria-invalid": "true" as const }
              : {})}
          />
        </div>

        {/* Error */}
        <AnimatePresence>
          {errorMessage !== null && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              id={`${formId}-error`}
              role="alert"
              aria-live="assertive"
              className="overflow-hidden"
            >
              <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Primary CTA: stark white, inverted text ── */}
        <button
          type="submit"
          disabled={isLoading || email.trim().length === 0}
          className={cn(
            "relative w-full overflow-hidden rounded-xl py-3 text-sm font-semibold",
            "bg-white text-zinc-900",
            "transition-all duration-150",
            "hover:bg-zinc-100 hover:-translate-y-[1px] hover:shadow-[0_4px_24px_rgba(255,255,255,0.12)]",
            "active:translate-y-0 active:shadow-none",
            "disabled:pointer-events-none disabled:opacity-40",
            "flex items-center justify-center gap-2",
          )}
        >
          {isMagicLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          )}
          {isMagicLoading ? "Sending link…" : "Continue with email"}
        </button>
      </form>

      {/* ── Passkey divider + button ── */}
      {hasPasskeySupport && (
        <>
          <OrDivider />

          {/* Passkey button — ghost with violet accent */}
          <button
            type="button"
            onClick={onPasskey}
            disabled={isLoading}
            aria-label="Sign in with your saved passkey"
            className={cn(
              "w-full flex items-center justify-center gap-2.5 rounded-xl py-3 text-sm font-medium",
              "border border-white/10 bg-white/[0.03]",
              "text-zinc-300 transition-all duration-150",
              "hover:border-violet-500/30 hover:bg-violet-500/[0.06] hover:text-violet-300",
              "active:scale-[0.99]",
              "disabled:pointer-events-none disabled:opacity-40",
            )}
          >
            {isPasskeyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
            ) : (
              <Fingerprint className="h-4 w-4 text-violet-400" />
            )}
            {isPasskeyLoading ? "Verifying…" : "Sign in with passkey"}
          </button>
        </>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Inner page — needs Suspense because of useSearchParams
// ---------------------------------------------------------------------------

function LoginPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const formId       = useId();
  const [, startTransition] = useTransition();

  const [authStep, setAuthStep]                     = useState<AuthStep>({ id: "idle" });
  const [hasPasskeySupport, setHasPasskeySupport]   = useState(false);

  const authError  = searchParams.get("error");
  const redirectTo = searchParams.get("redirect") ?? "/dashboard";

  // ── Passkey platform detection ─────────────────────────────────────────────
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.PublicKeyCredential === "undefined" ||
      typeof window.PublicKeyCredential
        .isUserVerifyingPlatformAuthenticatorAvailable !== "function"
    ) return;
    window.PublicKeyCredential
      .isUserVerifyingPlatformAuthenticatorAvailable()
      .then((ok) => setHasPasskeySupport(ok))
      .catch(() => setHasPasskeySupport(false));
  }, []);

  // ── Magic link (DO NOT MODIFY) ─────────────────────────────────────────────
  const handleMagicLink = useCallback(
    (email: string) => {
      setAuthStep({ id: "loading", method: "magic-link" });
      startTransition(async () => {
        try {
          const supabase = getSupabaseBrowserClient();
          const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
              // Use window.location.origin so the redirect always matches
              // the actual domain the user is on (www vs non-www).
              // absoluteUrl() was using NEXT_PUBLIC_APP_URL (baked at build
              // time) which could differ from the live origin and fail
              // Supabase's allowlist check, causing it to fall back to the
              // Site URL and bypass /api/auth/callback entirely.
              emailRedirectTo: `${window.location.origin}/api/auth/callback?redirect=${encodeURIComponent(redirectTo)}`,
              shouldCreateUser: true,
            },
          });
          if (error !== null) {
            setAuthStep({ id: "error", method: "magic-link", message: error.message });
            return;
          }
          setAuthStep({ id: "sent", email });
        } catch {
          setAuthStep({
            id: "error",
            method: "magic-link",
            message: "Something went wrong. Please try again.",
          });
        }
      });
    },
    [redirectTo],
  );

  // ── Google OAuth ──────────────────────────────────────────────────────────
  const handleGoogleOAuth = useCallback(() => {
    setAuthStep({ id: "loading", method: "google" });
    startTransition(async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: {
            // Same origin pattern as magic-link: use window.location.origin so
            // the redirect always matches the actual domain (www vs non-www),
            // and routes through our server-side PKCE exchange at /api/auth/callback.
            redirectTo: `${window.location.origin}/api/auth/callback?redirect=${encodeURIComponent(redirectTo)}`,
          },
        });
        if (error !== null) {
          setAuthStep({ id: "error", method: "google", message: error.message });
        }
        // On success Supabase immediately redirects the browser to Google — no
        // further state update needed; the tab navigates away.
      } catch {
        setAuthStep({
          id: "error",
          method: "google",
          message: "Google sign-in failed. Please try again.",
        });
      }
    });
  }, [redirectTo]);

  // ── Passkey (DO NOT MODIFY) ────────────────────────────────────────────────
  const handlePasskey = useCallback(() => {
    setAuthStep({ id: "loading", method: "passkey" });
    startTransition(async () => {
      try {
        const optionsRes = await fetch("/api/auth/passkey/authenticate/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!optionsRes.ok) throw new Error("Failed to initiate passkey authentication");

        setAuthStep({ id: "passkey-pending" });

        const options = (await optionsRes.json()) as PublicKeyCredentialRequestOptions;
        const credential = await navigator.credentials.get({
          publicKey: {
            ...options,
            challenge:
              options.challenge instanceof ArrayBuffer
                ? options.challenge
                : Uint8Array.from(
                    Object.values(
                      options.challenge as unknown as Record<string, number>,
                    ),
                  ),
          },
        });

        if (credential === null) throw new Error("No credential returned from authenticator");

        const verifyRes = await fetch("/api/auth/passkey/authenticate/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credential: {
              id: (credential as PublicKeyCredential).id,
              rawId: Array.from(
                new Uint8Array((credential as PublicKeyCredential).rawId),
              ),
              type: credential.type,
              response: {
                clientDataJSON: Array.from(
                  new Uint8Array(
                    (
                      (credential as PublicKeyCredential)
                        .response as AuthenticatorAssertionResponse
                    ).clientDataJSON,
                  ),
                ),
                authenticatorData: Array.from(
                  new Uint8Array(
                    (
                      (credential as PublicKeyCredential)
                        .response as AuthenticatorAssertionResponse
                    ).authenticatorData,
                  ),
                ),
                signature: Array.from(
                  new Uint8Array(
                    (
                      (credential as PublicKeyCredential)
                        .response as AuthenticatorAssertionResponse
                    ).signature,
                  ),
                ),
              },
            },
          }),
        });

        if (!verifyRes.ok) {
          const body = (await verifyRes.json()) as { error?: string };
          throw new Error(body.error ?? "Passkey verification failed");
        }

        router.push(redirectTo);
        router.refresh();
      } catch (err) {
        const isUserCancelled =
          err instanceof DOMException && err.name === "NotAllowedError";
        if (isUserCancelled) { setAuthStep({ id: "idle" }); return; }
        setAuthStep({
          id: "error",
          method: "passkey",
          message:
            err instanceof Error
              ? err.message
              : "Passkey authentication failed. Try signing in with email instead.",
        });
      }
    });
  }, [router, redirectTo]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    /*
     * Framer Motion card: fades in + slides up from y:20 over 0.6s.
     * The layout already provides the centered viewport shell.
     */
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Glassmorphism card */}
      <div
        className={cn(
          "rounded-2xl px-7 py-8",
          "bg-black/40 backdrop-blur-2xl",
          "border border-white/10",
          // Inner highlight on top edge + deep drop shadow for lift
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_64px_rgba(0,0,0,0.6)]",
        )}
      >
        {/* ── Callback error banner ── */}
        {authError === "auth-failed" && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Sign-in link expired or already used. Please request a new one.
          </div>
        )}

        {/* ── Card heading ── */}
        <div className="mb-7">
          <h1 className="text-xl font-semibold tracking-[-0.03em] text-white">
            Cinema, together.
          </h1>
          <p className="mt-1.5 text-sm text-zinc-400">
            Sign in to start or join a Watch Hub Sync session
          </p>
        </div>

        {/* ── Animated content area ── */}
        <div className="min-h-[280px]">
          <AnimatePresence mode="wait" initial={false}>
            {(authStep.id === "idle" ||
              authStep.id === "loading" ||
              authStep.id === "error") && (
              <LoginForm
                key="form"
                step={authStep}
                onMagicLink={handleMagicLink}
                onPasskey={handlePasskey}
                onGoogle={handleGoogleOAuth}
                hasPasskeySupport={hasPasskeySupport}
                formId={formId}
              />
            )}
            {authStep.id === "sent" && (
              <SentPanel
                key="sent"
                email={authStep.email}
                onRetry={() => setAuthStep({ id: "idle" })}
              />
            )}
            {authStep.id === "passkey-pending" && (
              <PasskeyPendingPanel key="passkey" />
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Default export — Suspense required for useSearchParams in App Router
// ---------------------------------------------------------------------------

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}
