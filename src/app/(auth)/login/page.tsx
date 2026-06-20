/**
 * src/app/(auth)/login/page.tsx
 *
 * WatchHubSync — Premium Cinematic Authentication Interface.
 *
 * Two sign-in paths:
 *
 *   1. Email Magic Link (OTP)
 *      → User enters email → Supabase sends a one-time link
 *      → Clicking the link hits /auth/callback → session established
 *
 *   2. FIDO Passkey
 *      → Browser calls navigator.credentials.get() with server challenge
 *      → Assertion sent to /api/auth/passkey/authenticate/complete
 *      → On success, a custom Supabase session is minted server-side
 *
 * States:
 *   idle       → form visible (email input + both buttons)
 *   loading    → spinner, inputs disabled
 *   sent       → magic link sent confirmation panel (animated)
 *   passkey    → passkey ceremony in progress (browser native UI handles it)
 *   error      → inline error with retry
 *
 * Performance:
 *   - No layout shift: the card has an explicit min-height
 *   - Passkey check is gated by `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`
 *     so the button only appears when hardware support exists
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
  Sparkles,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { absoluteUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthStep =
  | { id: "idle" }
  | { id: "loading"; method: "magic-link" | "passkey" }
  | { id: "sent"; email: string }
  | { id: "passkey-pending" }
  | { id: "error"; message: string; method: "magic-link" | "passkey" };

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

const panelVariants = {
  enter: {
    opacity: 0,
    y: 14,
    scale: 0.98,
    transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] },
  },
  center: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] },
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.99,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Success panel shown after magic link is dispatched */
function SentPanel({ email, onRetry }: { email: string; onRetry: () => void }) {
  return (
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
      className="flex flex-col items-center gap-5 text-center"
    >
      {/* Animated check */}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, ...SPRING }}
        className="relative flex h-16 w-16 items-center justify-center rounded-full bg-ok/10 ring-1 ring-ok/20"
      >
        <CheckCircle2 className="h-7 w-7 text-ok" aria-hidden="true" />
        {/* Pulse ring */}
        <span
          className="absolute inset-0 animate-ping-soft rounded-full ring-2 ring-ok/20"
          aria-hidden="true"
        />
      </motion.div>

      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-white">
          Check your inbox
        </h2>
        <p className="text-sm text-neutral-400">
          We sent a sign-in link to
        </p>
        <p className="rounded-lg bg-surface-raised px-3 py-1.5 text-sm font-medium text-white ring-1 ring-inset ring-white/[0.08]">
          {email}
        </p>
        <p className="text-xs text-neutral-600">
          The link expires in 60 minutes. Check spam if you don't see it.
        </p>
      </div>

      <button
        onClick={onRetry}
        className="text-xs text-neutral-600 underline underline-offset-2 transition-colors hover:text-neutral-300"
      >
        Didn't receive it? Try a different email
      </button>
    </motion.div>
  );
}

/** Passkey in-progress panel */
function PasskeyPendingPanel() {
  return (
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
      className="flex flex-col items-center gap-5 text-center"
    >
      <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 ring-1 ring-accent/20">
        <motion.div
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Fingerprint className="h-7 w-7 text-accent" aria-hidden="true" />
        </motion.div>
        <span
          className="absolute inset-0 animate-pulse-ring rounded-full"
          aria-hidden="true"
        />
      </div>

      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-white">
          Verifying your passkey
        </h2>
        <p className="text-sm text-neutral-400">
          Follow the prompt on your device — Touch ID, Face ID, or
          Windows Hello.
        </p>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main login form
// ---------------------------------------------------------------------------

function LoginForm({
  step,
  onMagicLink,
  onPasskey,
  hasPasskeySupport,
  formId,
}: {
  step: AuthStep;
  onMagicLink: (email: string) => void;
  onPasskey: () => void;
  hasPasskeySupport: boolean;
  formId: string;
}) {
  const [email, setEmail] = useState("");
  const isLoading = step.id === "loading";

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = email.trim().toLowerCase();
      if (trimmed.length === 0) return;
      onMagicLink(trimmed);
    },
    [email, onMagicLink],
  );

  const errorMessage =
    step.id === "error" ? step.message : null;

  return (
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-3"
        noValidate
        aria-label="Sign in with email"
      >
        {/* Email input */}
        <div className="space-y-1.5">
          <label
            htmlFor={`${formId}-email`}
            className="block text-xs font-medium text-neutral-400"
          >
            Email address
          </label>
          <div className="relative">
            <Mail
              className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600"
              aria-hidden="true"
            />
            <input
              id={`${formId}-email`}
              type="email"
              autoComplete="email"
              autoFocus
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isLoading}
              className={cn(
                "w-full rounded-xl bg-surface-raised py-3 pl-10 pr-4 text-sm text-white",
                "ring-1 ring-inset ring-white/[0.08]",
                "placeholder:text-neutral-700",
                "focus:outline-none focus:ring-2 focus:ring-accent/50",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "transition-shadow duration-150",
              )}
              aria-describedby={
                errorMessage !== null ? `${formId}-error` : undefined
              }
              aria-invalid={errorMessage !== null ? "true" : undefined}
            />
          </div>
        </div>

        {/* Inline error */}
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
              <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-3 text-xs text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Submit CTA */}
        <Button
          type="submit"
          size="lg"
          isLoading={isLoading && step.id === "loading" && step.method === "magic-link"}
          disabled={isLoading || email.trim().length === 0}
          rightIcon={
            isLoading ? undefined : (
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            )
          }
          className="w-full"
        >
          Continue with email
        </Button>
      </form>

      {/* Passkey option */}
      {hasPasskeySupport && (
        <>
          <div className="divider-label my-4">
            <span>or</span>
          </div>

          <Button
            variant="secondary"
            size="lg"
            onClick={onPasskey}
            isLoading={
              isLoading &&
              step.id === "loading" &&
              step.method === "passkey"
            }
            disabled={isLoading}
            leftIcon={
              <Fingerprint className="h-4 w-4 text-accent" aria-hidden="true" />
            }
            className="w-full"
            aria-label="Sign in with your saved passkey"
          >
            Sign in with passkey
          </Button>
        </>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formId = useId();
  const [, startTransition] = useTransition();

  const [authStep, setAuthStep] = useState<AuthStep>({ id: "idle" });
  const [hasPasskeySupport, setHasPasskeySupport] = useState(false);

  // Detect passkey platform support on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (
      typeof window.PublicKeyCredential === "undefined" ||
      typeof window.PublicKeyCredential
        .isUserVerifyingPlatformAuthenticatorAvailable !== "function"
    ) {
      return;
    }

    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((available) => setHasPasskeySupport(available))
      .catch(() => setHasPasskeySupport(false));
  }, []);

  // Handle redirect param (sent by middleware)
  const redirectTo = searchParams.get("redirect") ?? "/dashboard";

  // ── Magic link handler ─────────────────────────────────────────────────
  const handleMagicLink = useCallback(
    (email: string) => {
      setAuthStep({ id: "loading", method: "magic-link" });

      startTransition(async () => {
        try {
          const supabase = getSupabaseBrowserClient();

          const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
              // The callback URL — Supabase redirects here after email click.
              emailRedirectTo: absoluteUrl(`/auth/callback?redirect=${encodeURIComponent(redirectTo)}`),
              shouldCreateUser: true,
            },
          });

          if (error !== null) {
            setAuthStep({
              id: "error",
              method: "magic-link",
              message: error.message,
            });
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

  // ── Passkey handler ────────────────────────────────────────────────────
  const handlePasskey = useCallback(() => {
    setAuthStep({ id: "loading", method: "passkey" });

    startTransition(async () => {
      try {
        // Step 1: Get authentication options from server
        const optionsRes = await fetch("/api/auth/passkey/authenticate/begin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!optionsRes.ok) {
          throw new Error("Failed to initiate passkey authentication");
        }

        setAuthStep({ id: "passkey-pending" });

        const options = (await optionsRes.json()) as PublicKeyCredentialRequestOptions;

        // Step 2: Browser prompts user (Face ID / fingerprint / hardware key)
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

        if (credential === null) {
          throw new Error("No credential returned from authenticator");
        }

        // Step 3: Send assertion to server for verification
        const verifyRes = await fetch(
          "/api/auth/passkey/authenticate/complete",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              credential: {
                id: (credential as PublicKeyCredential).id,
                rawId: Array.from(
                  new Uint8Array(
                    (credential as PublicKeyCredential).rawId,
                  ),
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
          },
        );

        if (!verifyRes.ok) {
          const body = (await verifyRes.json()) as { error?: string };
          throw new Error(body.error ?? "Passkey verification failed");
        }

        // Step 4: Session established — refresh and redirect
        router.push(redirectTo);
        router.refresh();
      } catch (err) {
        // DOMException with name "NotAllowedError" means user cancelled
        const isUserCancelled =
          err instanceof DOMException && err.name === "NotAllowedError";

        if (isUserCancelled) {
          setAuthStep({ id: "idle" });
          return;
        }

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

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in">
      {/* Card */}
      <div className="glass rounded-2xl px-6 py-8 shadow-modal">
        {/* Brand header */}
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 ring-1 ring-inset ring-accent/25">
            <Sparkles className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-display text-white">
            Cinema, together.
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            Sign in to start or join a Watch Hub Sync session
          </p>
        </div>

        {/* Animated content area */}
        <div className="min-h-[200px]">
          <AnimatePresence mode="wait" initial={false}>
            {(authStep.id === "idle" ||
              authStep.id === "loading" ||
              authStep.id === "error") && (
              <LoginForm
                key="form"
                step={authStep}
                onMagicLink={handleMagicLink}
                onPasskey={handlePasskey}
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

      {/* Guest join prompt */}
      <p className="mt-6 text-center text-xs text-neutral-700">
        Have an invite link?{" "}
        <a
          href="/join"
          className="text-neutral-500 underline underline-offset-2 transition-colors hover:text-neutral-300"
        >
          Join as a guest
        </a>
      </p>
    </div>
  );
}

export default function LoginPageWrapper() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
