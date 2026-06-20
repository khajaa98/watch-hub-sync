/**
 * src/app/api/auth/callback/route.ts
 *
 * Supabase PKCE code-exchange callback for App Router.
 *
 * Supabase magic links land here with ?code=<pkce_code>.
 * We exchange that code for a server-side session (sets the auth cookie),
 * then redirect the user to their intended destination.
 *
 * Flow:
 *   email click → /api/auth/callback?code=…&redirect=/dashboard
 *                → exchangeCodeForSession()
 *                → 302 /dashboard   (or /login?error=auth-failed on failure)
 */

import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);

  const code     = searchParams.get("code");
  const redirect = searchParams.get("redirect") ?? "/dashboard";

  // Sanitise the redirect target — only allow relative paths to prevent open redirect.
  const safeRedirect = redirect.startsWith("/") ? redirect : "/dashboard";

  if (code === null || code.trim() === "") {
    return NextResponse.redirect(new URL("/login?error=auth-failed", origin));
  }

  try {
    const supabase = createSupabaseRouteHandlerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error !== null) {
      console.error("[WHS] PKCE exchange failed:", error.message);
      return NextResponse.redirect(new URL("/login?error=auth-failed", origin));
    }

    return NextResponse.redirect(new URL(safeRedirect, origin));
  } catch (err) {
    console.error("[WHS] Unexpected error in auth callback:", err);
    return NextResponse.redirect(new URL("/login?error=auth-failed", origin));
  }
}
