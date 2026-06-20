/**
 * src/types/supabase.ts
 *
 * Hand-authored Database type manifest for WatchHubSync.
 * Mirrors the Phase 1 SQL migrations exactly.
 *
 * In CI, regenerate with:
 *   supabase gen types typescript --project-id <ref> > src/types/supabase.ts
 *
 * DO NOT manually edit the generated section below after first codegen.
 */

// ---------------------------------------------------------------------------
// JSON scalar — matches Supabase's internal Json type exactly.
// Used for JSONB columns; consumers should narrow via Zod before use.
// ---------------------------------------------------------------------------
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------------------------------------------------------------------------
// Enum mirrors — kept in sync with 00001_create_enums.sql
// ---------------------------------------------------------------------------
export type SubscriptionTier = "free" | "premium";
export type Platform = "youtube" | "jiohotstar" | "netflix" | "primevideo";
export type RoomStatus = "waiting" | "active" | "closed";
export type ParticipantRole = "host" | "guest";
export type DeviceType = "primary" | "remote";
export type AuthProvider = "email" | "google" | "apple" | "passkey";

// ---------------------------------------------------------------------------
// JSONB domain shapes — strict types for each JSONB column.
// These are NOT enforced at the DB level; Zod schemas validate at runtime.
// ---------------------------------------------------------------------------

export interface RoomSettings {
  readonly content_id?: string;
  readonly content_title?: string;
  readonly content_thumbnail?: string;
  readonly max_participants?: number; // 0 = unlimited (premium only)
  readonly require_approval?: boolean;
  readonly has_international_guests?: boolean;
  readonly allow_chat?: boolean;
  readonly allow_reactions?: boolean;
  readonly sync_tolerance_ms?: number;
}

export interface PlaybackState {
  readonly is_playing: boolean;
  readonly position_seconds: number;
  readonly last_sync_at?: string; // ISO 8601
}

export interface GeoCheckResult {
  readonly country_code: string;
  readonly region?: string;
  readonly is_compatible: boolean;
  readonly warning?: string;
}

export interface ParticipantGeoMetadata {
  readonly country_code: string;
  readonly region?: string;
}

export interface BillingSessionBreakdownItem {
  readonly user_id: string;
  readonly device_type: DeviceType;
  readonly duration_seconds: number;
  readonly joined_at: string;
  readonly left_at: string;
}

// ---------------------------------------------------------------------------
// Database generic — the single source of truth for all Supabase client calls.
// ---------------------------------------------------------------------------
export interface Database {
  public: {
    Tables: {
      // -----------------------------------------------------------------------
      // users
      // -----------------------------------------------------------------------
      users: {
        Row: {
          id: string;
          email: string;
          auth_provider: AuthProvider;
          subscription_tier: SubscriptionTier;
          display_name: string | null;
          avatar_url: string | null;
          stripe_customer_id: string | null;
          razorpay_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          auth_provider?: AuthProvider;
          subscription_tier?: SubscriptionTier;
          display_name?: string | null;
          avatar_url?: string | null;
          stripe_customer_id?: string | null;
          razorpay_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          auth_provider?: AuthProvider;
          subscription_tier?: SubscriptionTier;
          display_name?: string | null;
          avatar_url?: string | null;
          stripe_customer_id?: string | null;
          razorpay_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      // -----------------------------------------------------------------------
      // rooms
      // -----------------------------------------------------------------------
      rooms: {
        Row: {
          id: string;
          host_id: string;
          status: RoomStatus;
          platform: Platform;
          settings: Json;
          livekit_room_name: string | null;
          invite_token_hash: string | null;
          invite_expires_at: string | null;
          geo_check_result: Json | null;
          playback_state: Json;
          created_at: string;
          updated_at: string;
          closed_at: string | null;
        };
        Insert: {
          id?: string;
          host_id: string;
          status?: RoomStatus;
          platform: Platform;
          settings?: Json;
          livekit_room_name?: string | null;
          invite_token_hash?: string | null;
          invite_expires_at?: string | null;
          geo_check_result?: Json | null;
          playback_state?: Json;
          created_at?: string;
          updated_at?: string;
          closed_at?: string | null;
        };
        Update: {
          id?: string;
          host_id?: string;
          status?: RoomStatus;
          platform?: Platform;
          settings?: Json;
          livekit_room_name?: string | null;
          invite_token_hash?: string | null;
          invite_expires_at?: string | null;
          geo_check_result?: Json | null;
          playback_state?: Json;
          created_at?: string;
          updated_at?: string;
          closed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "rooms_host_id_fkey";
            columns: ["host_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };

      // -----------------------------------------------------------------------
      // participants
      // -----------------------------------------------------------------------
      participants: {
        Row: {
          id: string;
          room_id: string;
          user_id: string;
          role: ParticipantRole;
          device_type: DeviceType;
          livekit_identity: string | null;
          geo_metadata: Json;
          joined_at: string;
          left_at: string | null;
        };
        Insert: {
          id?: string;
          room_id: string;
          user_id: string;
          role?: ParticipantRole;
          device_type?: DeviceType;
          livekit_identity?: string | null;
          geo_metadata?: Json;
          joined_at?: string;
          left_at?: string | null;
        };
        Update: {
          id?: string;
          room_id?: string;
          user_id?: string;
          role?: ParticipantRole;
          device_type?: DeviceType;
          livekit_identity?: string | null;
          geo_metadata?: Json;
          joined_at?: string;
          left_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "participants_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "participants_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };

      // -----------------------------------------------------------------------
      // billing_meters
      // -----------------------------------------------------------------------
      billing_meters: {
        Row: {
          id: string;
          host_id: string;
          room_id: string;
          participant_minutes: number;
          session_breakdown: Json;
          billing_period_start: string;
          billing_period_end: string;
          livekit_event_id: string;
          is_processed: boolean;
          payment_event_id: string | null;
          processing_error: string | null;
          created_at: string;
          processed_at: string | null;
        };
        Insert: {
          id?: string;
          host_id: string;
          room_id: string;
          participant_minutes: number;
          session_breakdown?: Json;
          billing_period_start: string;
          billing_period_end: string;
          livekit_event_id: string;
          is_processed?: boolean;
          payment_event_id?: string | null;
          processing_error?: string | null;
          created_at?: string;
          processed_at?: string | null;
        };
        Update: {
          id?: string;
          host_id?: string;
          room_id?: string;
          participant_minutes?: number;
          session_breakdown?: Json;
          billing_period_start?: string;
          billing_period_end?: string;
          livekit_event_id?: string;
          is_processed?: boolean;
          payment_event_id?: string | null;
          processing_error?: string | null;
          created_at?: string;
          processed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "billing_meters_host_id_fkey";
            columns: ["host_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_meters_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
    };

    Views: Record<string, never>;

    Functions: Record<string, never>;

    Enums: {
      subscription_tier: SubscriptionTier;
      platform: Platform;
      room_status: RoomStatus;
      participant_role: ParticipantRole;
      device_type: DeviceType;
    };

    CompositeTypes: Record<string, never>;
  };
}

// ---------------------------------------------------------------------------
// Convenience row-type aliases — use these in application code.
// ---------------------------------------------------------------------------
export type UserRow = Database["public"]["Tables"]["users"]["Row"];
export type RoomRow = Database["public"]["Tables"]["rooms"]["Row"];
export type ParticipantRow =
  Database["public"]["Tables"]["participants"]["Row"];
export type BillingMeterRow =
  Database["public"]["Tables"]["billing_meters"]["Row"];

// ---------------------------------------------------------------------------
// Supabase Auth JWT payload — shape of the decoded access token.
// Extends the JOSE JWTPayload with Supabase-specific claims.
// ---------------------------------------------------------------------------
export interface SupabaseJWTPayload {
  /** Subject — Supabase user UUID */
  sub: string;
  /** Audience: always "authenticated" for logged-in users */
  aud: "authenticated" | "anon";
  /** Supabase role */
  role: "authenticated" | "anon" | "service_role";
  /** Email from auth.users */
  email?: string;
  /** Phone from auth.users */
  phone?: string;
  app_metadata: {
    provider: AuthProvider;
    providers: AuthProvider[];
  };
  user_metadata: Record<string, unknown>;
  /** Authenticator Assurance Level */
  aal: "aal1" | "aal2";
  /** Issued at (Unix seconds) */
  iat: number;
  /** Expiry (Unix seconds) */
  exp: number;
  /** JWT issuer — the Supabase project auth URL */
  iss: string;
  session_id: string;
}
