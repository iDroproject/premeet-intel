// Auth middleware for PreMeet Edge Functions.
// Extracts and verifies the JWT from the Authorization header,
// validates the session exists in DB, and returns user context.

import { verifyToken, type PreMeetJwtPayload } from './jwt';
import { sql } from './db';
import { getCorsHeaders } from './cors';

export interface AuthContext {
  userId: string;
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  sessionId: string;
}

export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: Response };

export async function requireAuth(req: Request): Promise<AuthResult> {
  const cors = getCorsHeaders(req.headers.get('origin'));
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      ),
    };
  }

  const token = authHeader.slice(7);

  let payload: PreMeetJwtPayload;
  try {
    payload = await verifyToken(token);
  } catch {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      ),
    };
  }

  if (payload.type !== 'access') {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Invalid token type. Use an access token.' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      ),
    };
  }

  // Verify session still exists and is not expired
  const sessions = await sql`
    SELECT id, expires_at FROM sessions WHERE id = ${payload.sessionId} LIMIT 1
  `;

  if (sessions.length === 0) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Session not found or expired' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      ),
    };
  }

  const session = sessions[0];

  if (new Date(session.expires_at) < new Date()) {
    // Clean up expired session
    await sql`DELETE FROM sessions WHERE id = ${payload.sessionId}`;
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Session expired' }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } },
      ),
    };
  }

  return {
    ok: true,
    context: {
      userId: payload.sub,
      email: payload.email,
      tier: payload.tier,
      sessionId: payload.sessionId,
    },
  };
}
