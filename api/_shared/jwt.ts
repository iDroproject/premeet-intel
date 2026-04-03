// JWT utilities for PreMeet session management.
// Creates and verifies signed JWTs for user sessions.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const ISSUER = 'premeet';
const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_TTL = '30d';

function getJwtSecret(): Uint8Array {
  const raw = process.env.PREMEET_JWT_SECRET;
  if (!raw) {
    throw new Error('PREMEET_JWT_SECRET is not set. Generate one with: openssl rand -hex 32');
  }
  return new TextEncoder().encode(raw);
}

export interface PreMeetJwtPayload extends JWTPayload {
  sub: string; // user ID
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  type: 'access' | 'refresh';
  sessionId: string;
}

export async function createAccessToken(payload: {
  userId: string;
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  sessionId: string;
}): Promise<string> {
  const JWT_SECRET = getJwtSecret();
  return new SignJWT({
    email: payload.email,
    tier: payload.tier,
    type: 'access' as const,
    sessionId: payload.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(JWT_SECRET);
}

export async function createRefreshToken(payload: {
  userId: string;
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  sessionId: string;
}): Promise<string> {
  const JWT_SECRET = getJwtSecret();
  return new SignJWT({
    email: payload.email,
    tier: payload.tier,
    type: 'refresh' as const,
    sessionId: payload.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<PreMeetJwtPayload> {
  const JWT_SECRET = getJwtSecret();
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    issuer: ISSUER,
  });
  return payload as PreMeetJwtPayload;
}

/** Hash a token for storage in the sessions table */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
