/**
 * src/app/(auth)/login/page.tsx
 *
 * WatchHubSync — Cinematic Authentication Card.
 *
 * The outer page shell (background, logo, footer, centering) is handled by
 * src/app/(auth)/layout.tsx — this component renders only the card content.
 *
 * Two sign-in paths:
 *   1. Email Magic Link (PKCE) → /api/auth/callback
 *   2. FIDO Passkey → navigator.credentials.get()
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
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { absoluteUrl, cn } from "@/lib/utils";
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
  enter:  { opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  center: { opacity: 1, y: 0,  scale: 1,    transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit:   { opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.18, ease: "easeIn" } },
};

// ---------------------------------------------------------------------------
// Sub-components
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
        className="relative flex h-16 w-16 items-center justify-center rounded-full bg-ok/10 ring-1 ring-ok/20"
      >
        <CheckCircle2 className="h-7 w-7 text-ok" />
        <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-ok/20 [animation-duration:2s]" />
      </motion.div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold text-white">Check your inbox</h2>
        <p className="text-sm text-neutral-400">We sent a sign-in link to</p>
        <p className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium text-white ring-1 ring-inset ring-white/[0.08]">
          {email}
        </p>
        <p className="text-xs text-neutral-600">
          Link expires in 60 minutes · check spam if you don't see it
        </p>
      </div>

      <button
        onClick={onRetry}
        className="text-xs text-neutral-600 underline underline-offset-2 transition-colors hover:text-neutral-300"
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
      <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 ring-1 ring-accent/20">
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Fingerprint className="h-7 w-7 text-accent" />
        </motion.div>
        <span className="absolute inset-0 animate-pulse-ring rounded-full" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-white">Verifying passkey</h2>
        <p className="text-sm text-neutral-400">
          Follow the prompt — Touch ID, Face ID, or Windows Hello
        </p>
      </div>
    </motion.div>
  );
}

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
  const errorMessage = step.id === "error" ? step.message : null;

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
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-4"
        noValidate
        aria-label="Sign in with email"
      >
        <div className="space-y-2">
          <label
            htmlFor={`${formId}-email`}
            className="block text-xs font-medium text-neutral-400"
          >
            Email address
          </label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
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
                "disabled:cursor-not-allowed disabled:opacity-50",
                "transition-all duration-150",
              )}
              aria-describedby={errorMessage !== null ? `${formId}-error` : undefined}
              aria-invalid={errorMessage !== null ? "true" : undefined}
            />
          </div>
        </div>

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
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <Button
          type="submit"
          size="lg"
          isLoading={isLoading && step.id === "loading" && step.method === "magic-link"}
          disabled={isLoading || email.trim().length === 0}
          rightIcon={isLoading ? undefined : <ArrowRight className="h-4 w-4" />}
          className="w-full"
        >
          Continue with email
        </Button>
      </form>

      {hasPasskeySupport && (
        <>
          <div className="divider-label my-5">
            <span>or</span>
          </div>
          <Button
            variant="secondary"
            size="lg"
            onClick={onPasskey}
            isLoading={isLoading && step.id === "loading" && step.method === "passkey"}
            disabled={isLoading}
            leftIcon={<Fingerprint className="h-4 w-4 text-accent" />}
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
// Page inner — needs Suspense because of useSearchParams
// ---------------------------------------------------------------------------

function LoginPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const formId       = useId();
  const [, startTransition] = useTransition();

  const [authStep, setAuthStep]           = useState<AuthStep>({ id: "idle" });
  const [hasPasskeySupport, setHasPasskeySupport] = useState(false);

  const authError  = searchParams.get("error");
  const redirectTo = searchParams.get("redirect") ?? "/dashboard";

  // Passkey platform detection
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

  // ── Magic link ────────────────────────────────────────────────────────────
  const handleMagicLink = useCallback(
    (email: string) => {
      setAuthStep({ id: "loading", method: "magic-link" });
      startTransition(async () => {
        try {
          const supabase = getSupabaseBrowserClient();
          const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
              emailRedirectTo: absoluteUrl(
                `/api/auth/callback?redirect=${encodeURIComponent(redirectTo)}`,
              ),
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

  // ── Passkey ───────────────────────────────────────────────────────────────
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
              rawId: Array.from(new Uint8Array((credential as PublicKeyCredential).rawId)),
              type: credential.type,
              response: {
                clientDataJSON: Array.from(
                  new Uint8Array(
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse)
                      .clientDataJSON,
                  ),
                ),
                authenticatorData: Array.from(
                  new Uint8Array(
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse)
                      .authenticatorData,
                  ),
                ),
                signature: Array.from(
                  new Uint8Array(
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse)
                      .signature,
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="glass rounded-2xl px-6 py-8 shadow-modal">
      {/* Callback auth error (e.g. expired magic link) */}
      {authError === "auth-failed" && (
        <div className="mb-5 flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-3 text-xs text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Sign-in link expired or already used. Please request a new one.
        </div>
      )}

      {/* Card header */}
      <div className="mb-6">
        <h1 className="text-base font-semibold text-white">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Enter your email to receive a magic link
        </p>
      </div>

      {/* Animated content area */}
      <div className="min-h-[180px]">
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
  );
}

// ---------------------------------------------------------------------------
// Default export — Suspense wrapper required for useSearchParams
// ---------------------------------------------------------------------------

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}
