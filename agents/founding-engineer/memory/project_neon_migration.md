---
name: Neon Migration
description: Supabase dropped in favor of Neon Serverless Postgres; BrightData called directly from extension
type: project
---

Supabase has been fully replaced by Neon Serverless Postgres for all database and edge function needs.

**Why:** Simplify the backend stack and reduce dependencies. BrightData APIs are called directly from the extension rather than proxied through edge functions.

**How to apply:** Never reference Supabase in new code. Database migrations go in `neon/schema/`. Edge functions live in `functions/`. All auth and billing functions have been migrated to the new structure.
