/**
 * src/app/(auth)/login/page.tsx
 *
 * WatchHubSync — Cinematic Authentication Interface.
 *
 * Two sign-in paths:
 *   1. Email Magic Link (OTP / PKCE) → /api/auth/callback
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
      className="flex flex-col items-center gap-6 py-2 text-center"
    >
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, ...SPRING }}
        className="relative flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20"
      >
        <CheckCircle2 className="h-7 w-7 text-emerald-400" />
        <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-emerald-500/20 [animation-duration:2s]" />
      </motion.div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold text-white">Check your inbox</h2>
        <p className="text-sm text-zinc-400">We sent a sign-in link to</p>
        <p className="rounded-lg bg-zinc-800/80 px-4 py-2 text-sm font-medium text-white ring-1 ring-inset ring-white/[0.08]">
          {email}
        </p>
        <p className="text-xs text-zinc-600">
          Link expires in 60 minutes · check spam if you don't see it
        </p>
      </div>

      <button
        onClick={onRetry}
        className="text-xs text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-300"
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
      className="flex flex-col items-center gap-6 py-2 text-center"
    >
      <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-violet-500/10 ring-1 ring-violet-500/20">
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Fingerprint className="h-7 w-7 text-violet-400" />
        </motion.div>
        <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-violet-500/20 [animation-duration:2s]" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-white">Verifying passkey</h2>
        <p className="text-sm text-zinc-400">
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
    <motion.div
      variants={panelVariants}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="space-y-4"
        noValidate
        aria-label="Sign in with email"
      >
        {/* Email field */}
        <div className="space-y-2">
          <label
            htmlFor={`${formId}-email`}
            className="block text-xs font-medium text-zinc-400"
          >
            Email address
          </label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
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
                "w-full rounded-xl bg-zinc-800/60 py-3 pl-10 pr-4 text-sm text-white",
                "ring-1 ring-inset ring-white/[0.08]",
                "placeholder:text-zinc-600",
                "focus:outline-none focus:ring-2 focus:ring-violet-500/50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "transition-all duration-150",
              )}
              aria-describedby={errorMessage !== null ? `${formId}-error` : undefined}
              aria-invalid={errorMessage !== null ? "true" : undefined}
            />
          </div>
        </div>

        {/* Error message */}
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
              <div className="flex items-start gap-2 rounded-xl bg-red-500/10 px-3.5 py-3 text-xs text-red-400 ring-1 ring-inset ring-red-500/20">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Primary CTA */}
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

      {/* Passkey divider + button */}
      {hasPasskeySupport && (
        <>
          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/[0.06]" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-zinc-900 px-3 text-xs text-zinc-600">or</span>
            </div>
          </div>

          <Button
            variant="secondary"
            size="lg"
            onClick={onPasskey}
            isLoading={isLoading && step.id === "loading" && step.method === "passkey"}
            disabled={isLoading}
            leftIcon={<Fingerprint className="h-4 w-4 text-violet-400" />}
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
// Page inner (uses useSearchParams — must be inside <Suspense>)
// ---------------------------------------------------------------------------

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formId = useId();
  const [, startTransition] = useTransition();

  const [authStep, setAuthStep] = useState<AuthStep>({ id: "idle" });
  const [hasPasskeySupport, setHasPasskeySupport] = useState(false);

  // Auth error from callback redirect
  const authError = searchParams.get("error");

  // Passkey platform detection
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.PublicKeyCredential === "undefined" ||
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function"
    ) return;

    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((ok) => setHasPasskeySupport(ok))
      .catch(() => setHasPasskeySupport(false));
  }, []);

  const redirectTo = searchParams.get("redirect") ?? "/dashboard";

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
                    Object.values(options.challenge as unknown as Record<string, number>),
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
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse).clientDataJSON,
                  ),
                ),
                authenticatorData: Array.from(
                  new Uint8Array(
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse).authenticatorData,
                  ),
                ),
                signature: Array.from(
                  new Uint8Array(
                    ((credential as PublicKeyCredential).response as AuthenticatorAssertionResponse).signature,
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
        const isUserCancelled = err instanceof DOMException && err.name === "NotAllowedError";
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 py-12">
      {/* Ambient glow */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute left-1/2 top-0 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600/10 blur-[120px]" />
      </div>

      {/* Logo mark */}
      <div className="relative mb-8 flex flex-col items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/10 ring-1 ring-inset ring-violet-500/20">
          <span className="text-lg font-bold tracking-tighter text-violet-400">W</span>
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-tight text-white">
            Watch Hub Sync
          </h1>
          <p className="text-sm text-zinc-500">Cinema, together.</p>
        </div>
      </div>

      {/* Glass card */}
      <div className="relative w-full max-w-sm">
        {/* Card glow border */}
        <div
          className="pointer-events-none absolute -inset-px rounded-2xl"
          style={{
            background:
              "linear-gradient(145deg, rgba(139,92,246,0.15), rgba(255,255,255,0.03) 60%)",
          }}
          aria-hidden="true"
        />
        <div className="relative rounded-2xl bg-zinc-900/80 px-6 py-8 shadow-2xl ring-1 ring-inset ring-white/[0.06] backdrop-blur-xl">
          {/* Callback auth error */}
          {authError === "auth-failed" && (
            <div className="mb-5 flex items-start gap-2 rounded-xl bg-red-500/10 px-3.5 py-3 text-xs text-red-400 ring-1 ring-inset ring-red-500/20">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Sign-in link expired or already used. Please request a new one.
            </div>
          )}

          <div className="mb-6">
            <h2 className="text-base font-semibold text-white">Sign in</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Enter your email to receive a magic link
            </p>
          </div>

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
      </div>

      <p className="relative mt-6 text-xs text-zinc-700">
        By signing in you agree to our{" "}
        <a
          href="/terms"
          className="text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-400"
        >
          Terms
        </a>{" "}
        and{" "}
        <a
          href="/privacy"
          className="text-zinc-600 underline underline-offset-2 transition-colors hover:text-zinc-400"
        >
          Privacy Policy
        </a>
        .
      </p>
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
