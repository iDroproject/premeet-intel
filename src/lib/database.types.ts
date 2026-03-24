// PreMeet – Supabase Database Types
// Generated from the schema; keep in sync with migrations.
// In production, regenerate via: npx supabase gen types typescript --project-id <id>

export type SubscriptionTier = 'free' | 'pro';
export type EntityType = 'person' | 'company';
export type EnrichmentStatus = 'pending' | 'success' | 'partial' | 'failed' | 'cached';
export type ConfidenceLevel = 'high' | 'good' | 'partial' | 'low';

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          name: string | null;
          google_oauth_id: string | null;
          subscription_tier: SubscriptionTier;
          credits_used: number;
          credits_limit: number;
          credits_reset_month: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          name?: string | null;
          google_oauth_id?: string | null;
          subscription_tier?: SubscriptionTier;
          credits_used?: number;
          credits_limit?: number;
          credits_reset_month?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          name?: string | null;
          google_oauth_id?: string | null;
          subscription_tier?: SubscriptionTier;
          credits_used?: number;
          credits_limit?: number;
          credits_reset_month?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      enrichment_cache: {
        Row: {
          id: string;
          entity_type: EntityType;
          entity_key: string;
          enrichment_data: Record<string, unknown>;
          confidence: ConfidenceLevel | null;
          confidence_score: number | null;
          source: string | null;
          fetched_at: string;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          entity_type: EntityType;
          entity_key: string;
          enrichment_data: Record<string, unknown>;
          confidence?: ConfidenceLevel | null;
          confidence_score?: number | null;
          source?: string | null;
          fetched_at?: string;
          expires_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          entity_type?: EntityType;
          entity_key?: string;
          enrichment_data?: Record<string, unknown>;
          confidence?: ConfidenceLevel | null;
          confidence_score?: number | null;
          source?: string | null;
          fetched_at?: string;
          expires_at?: string;
          created_at?: string;
        };
      };
      sessions: {
        Row: {
          id: string;
          user_id: string;
          token_hash: string;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          token_hash: string;
          expires_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          token_hash?: string;
          expires_at?: string;
          created_at?: string;
        };
      };
      enrichment_requests: {
        Row: {
          id: string;
          user_id: string;
          entity_type: EntityType;
          entity_key: string;
          credits_used: number;
          status: EnrichmentStatus;
          cache_hit: boolean;
          meeting_title: string | null;
          requested_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          entity_type: EntityType;
          entity_key: string;
          credits_used?: number;
          status?: EnrichmentStatus;
          cache_hit?: boolean;
          meeting_title?: string | null;
          requested_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          entity_type?: EntityType;
          entity_key?: string;
          credits_used?: number;
          status?: EnrichmentStatus;
          cache_hit?: boolean;
          meeting_title?: string | null;
          requested_at?: string;
          completed_at?: string | null;
        };
      };
      cache_stats: {
        Row: {
          id: string;
          date: string;
          entity_type: EntityType;
          hits: number;
          misses: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          date: string;
          entity_type: EntityType;
          hits?: number;
          misses?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          date?: string;
          entity_type?: EntityType;
          hits?: number;
          misses?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: {
      upsert_cache_stat: {
        Args: {
          p_date: string;
          p_entity_type: EntityType;
          p_hits?: number;
          p_misses?: number;
        };
        Returns: undefined;
      };
    };
    Enums: {
      subscription_tier: SubscriptionTier;
      entity_type: EntityType;
      enrichment_status: EnrichmentStatus;
      confidence_level: ConfidenceLevel;
    };
    CompositeTypes: Record<string, never>;
  };
}
