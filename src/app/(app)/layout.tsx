/**
 * src/app/(app)/layout.tsx
 *
 * Authenticated app shell layout.
 * Wraps /dashboard, /rooms/**, /billing.
 *
 * Server-side session guard: redirects to /login if no authenticated user.
 * Client-side: renders the top navigation bar.
 */

import { redirect } from "next/navigation";
import { createSupabaseServerComponentClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/layout/app-nav";

interface AppLayoutProps {
  readonly children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const supabase = createSupabaseServerComponentClient();

  // Server-authoritative session check.
  // getUser() validates the token against the Supabase Auth server.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch minimal profile for nav display — parallel to page data fetches.
  const { data: profileRaw } = await supabase
    .from("users")
    .select("display_name, avatar_url, subscription_tier")
    .eq("id", user.id)
    .single();
  const profile = profileRaw as unknown as {
    display_name: string | null;
    avatar_url: string | null;
    subscription_tier: "free" | "premium";
  } | null;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <AppNav
        userId={user.id}
        displayName={profile?.display_name ?? null}
        avatarUrl={profile?.avatar_url ?? null}
        tier={profile?.subscription_tier ?? "free"}
      />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
