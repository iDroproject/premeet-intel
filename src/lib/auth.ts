// PreMeet — Client-side Auth Service
// Manages Google OAuth sign-in via chrome.identity and session tokens
// via the PreMeet Edge Functions.

const LOG = '[PreMeet][Auth]';

// Storage keys
const STORAGE_KEYS = {
  accessToken: 'premeet_access_token',
  refreshToken: 'premeet_refresh_token',
  user: 'premeet_user',
  expiresAt: 'premeet_session_expires_at',
} as const;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  tier: 'free' | 'pro';
  credits: {
    used: number;
    limit: number;
    resetMonth: string;
  };
}

export interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  accessToken: string | null;
}

function getApiBaseUrl(): string {
  // API base URL for PreMeet edge functions, injected at build time
  const url = import.meta.env.VITE_API_BASE_URL as string;
  return url || '';
}

// ── Token Storage ─────────────────────────────────────────────────────────

async function storeTokens(accessToken: string, refreshToken: string, expiresAt: string, user: AuthUser): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.accessToken]: accessToken,
    [STORAGE_KEYS.refreshToken]: refreshToken,
    [STORAGE_KEYS.expiresAt]: expiresAt,
    [STORAGE_KEYS.user]: JSON.stringify(user),
  });
}

async function getStoredTokens(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  user: AuthUser | null;
}> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.expiresAt,
    STORAGE_KEYS.user,
  ]);

  const userStr = result[STORAGE_KEYS.user];
  return {
    accessToken: result[STORAGE_KEYS.accessToken] ?? null,
    refreshToken: result[STORAGE_KEYS.refreshToken] ?? null,
    expiresAt: result[STORAGE_KEYS.expiresAt] ?? null,
    user: userStr ? JSON.parse(userStr) : null,
  };
}

async function clearStoredTokens(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.expiresAt,
    STORAGE_KEYS.user,
  ]);
}

// ── Google OAuth ──────────────────────────────────────────────────────────

/**
 * Initiates Google OAuth sign-in via chrome.identity.
 * Gets a Google access token and exchanges it for PreMeet session tokens.
 */
export async function signInWithGoogle(): Promise<AuthState> {
  console.log(LOG, 'Starting Google sign-in...');

  // Get Google access token via Chrome identity API
  const googleToken = await new Promise<string>((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error('No token received from Google'));
        return;
      }
      resolve(token);
    });
  });

  // Exchange Google token for PreMeet session tokens
  const baseUrl = getApiBaseUrl();
  const res = await fetch(`${baseUrl}/auth-google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ googleAccessToken: googleToken }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(body.error || `Auth failed (${res.status})`);
  }

  const data = await res.json();

  const user: AuthUser = data.user;
  await storeTokens(data.accessToken, data.refreshToken, data.expiresAt, user);

  console.log(LOG, `Signed in as ${user.email}`);

  return { isAuthenticated: true, user, accessToken: data.accessToken };
}

// ── Token Refresh ─────────────────────────────────────────────────────────

/**
 * Refreshes the access token using the stored refresh token.
 * Returns the new access token or null if refresh failed.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = await getStoredTokens();
  if (!refreshToken) return null;

  try {
    const baseUrl = getApiBaseUrl();
    const res = await fetch(`${baseUrl}/auth-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      console.warn(LOG, 'Token refresh failed, clearing session');
      await clearStoredTokens();
      return null;
    }

    const { accessToken } = await res.json();

    // Update stored access token
    await chrome.storage.local.set({ [STORAGE_KEYS.accessToken]: accessToken });

    return accessToken;
  } catch (err) {
    console.error(LOG, 'Refresh error:', (err as Error).message);
    return null;
  }
}

// ── Sign Out ──────────────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  const { accessToken } = await getStoredTokens();

  // Invalidate server-side session
  if (accessToken) {
    try {
      const baseUrl = getApiBaseUrl();
      await fetch(`${baseUrl}/auth-logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch {
      // Best-effort logout on server
    }
  }

  // Revoke the Google token
  try {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token });
      }
    });
  } catch {
    // Best-effort Google token revocation
  }

  await clearStoredTokens();

  console.log(LOG, 'Signed out');
}

// ── Get Current Auth State ────────────────────────────────────────────────

export async function getAuthState(): Promise<AuthState> {
  const { accessToken, refreshToken, user } = await getStoredTokens();

  if (!accessToken || !user) {
    return { isAuthenticated: false, user: null, accessToken: null };
  }

  return { isAuthenticated: true, user, accessToken };
}

// ── Get Current User (with server refresh) ────────────────────────────────

export async function getCurrentUser(): Promise<AuthUser | null> {
  let { accessToken } = await getStoredTokens();
  if (!accessToken) return null;

  const baseUrl = getApiBaseUrl();
  let res = await fetch(`${baseUrl}/auth-me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // If 401, try refreshing the token
  if (res.status === 401) {
    accessToken = await refreshAccessToken();
    if (!accessToken) return null;

    res = await fetch(`${baseUrl}/auth-me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!res.ok) return null;

  const { user } = await res.json();

  // Update stored user data
  await chrome.storage.local.set({ [STORAGE_KEYS.user]: JSON.stringify(user) });

  return user;
}

// ── Authenticated Fetch Helper ────────────────────────────────────────────

/**
 * Makes an authenticated fetch request. Automatically refreshes the
 * access token on 401 and retries once.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  let { accessToken } = await getStoredTokens();

  if (!accessToken) {
    throw new Error('Not authenticated');
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    accessToken = await refreshAccessToken();
    if (!accessToken) {
      throw new Error('Session expired. Please sign in again.');
    }

    headers.set('Authorization', `Bearer ${accessToken}`);
    res = await fetch(url, { ...init, headers });
  }

  return res;
}
