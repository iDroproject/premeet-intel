// PreMeet first-run onboarding
// Shows a minimal welcome tooltip, meeting detection hint, and success
// confirmation. Runs once per install using chrome.storage.local flag.

const LOG = '[PreMeet][Onboarding]';
const STORAGE_KEY = 'premeet_onboarding_done';

let active = false;
let welcomeDismissed = false;

// ─── Storage ──────────────────────────────────────────────────────────────────

async function isDone(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEY, (r) => {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(r[STORAGE_KEY] === true);
      });
    } catch { resolve(true); }
  });
}

function markDone(): void {
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: true }, () => {
      if (chrome.runtime.lastError) return;
      console.log(LOG, 'Onboarding marked complete');
    });
  } catch { /* context invalidated */ }
}

// ─── Welcome Tooltip ──────────────────────────────────────────────────────────

function showWelcome(): void {
  if (document.querySelector('.pm-onboard-welcome')) return;

  const el = document.createElement('div');
  el.className = 'pm-onboard-welcome';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Welcome to PreMeet');
  el.innerHTML = `
    <div class="pm-onboard-welcome__content">
      <div class="pm-onboard-welcome__icon" aria-hidden="true">&#x1F4CB;</div>
      <div class="pm-onboard-welcome__text">
        <strong>PreMeet is ready!</strong>
        <span>Open a meeting with guests — PreMeet will automatically brief you on every attendee.</span>
      </div>
      <button class="pm-onboard-welcome__close" aria-label="Dismiss" type="button">&times;</button>
    </div>
  `;

  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('pm-onboard-welcome--visible'));

  el.querySelector('.pm-onboard-welcome__close')!
    .addEventListener('click', () => dismissWelcome(el));

  setTimeout(() => dismissWelcome(el), 12000);
  console.log(LOG, 'Welcome tooltip shown');
}

function dismissWelcome(el: HTMLElement): void {
  if (welcomeDismissed) return;
  welcomeDismissed = true;
  if (el.isConnected) {
    el.classList.remove('pm-onboard-welcome--visible');
    el.classList.add('pm-onboard-welcome--exit');
    setTimeout(() => el.remove(), 300);
  }
}

// ─── Meeting Detection Hint ───────────────────────────────────────────────────

function showDetectionHint(): void {
  if (!active) return;

  // Dismiss welcome if still visible
  const welcome = document.querySelector('.pm-onboard-welcome') as HTMLElement | null;
  if (welcome) dismissWelcome(welcome);

  // Don't show hint if already shown
  if (document.querySelector('.pm-onboard-hint')) return;

  const hint = document.createElement('div');
  hint.className = 'pm-onboard-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.innerHTML = `
    <span class="pm-onboard-hint__spinner" aria-hidden="true"></span>
    <span>PreMeet is looking up the attendees…</span>
  `;

  document.body.appendChild(hint);
  requestAnimationFrame(() => hint.classList.add('pm-onboard-hint--visible'));

  // Auto-dismiss after 8s if enrichment hasn't completed
  setTimeout(() => {
    if (hint.isConnected) {
      hint.classList.remove('pm-onboard-hint--visible');
      setTimeout(() => hint.remove(), 300);
    }
  }, 8000);

  console.log(LOG, 'Detection hint shown');
}

// ─── Success Confirmation ─────────────────────────────────────────────────────

function showSuccess(): void {
  if (!active) return;
  active = false;

  // Remove any remaining onboarding UI
  document.querySelectorAll('.pm-onboard-welcome, .pm-onboard-hint').forEach((el) => el.remove());

  const toast = document.createElement('div');
  toast.className = 'pm-onboard-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = `
    <span class="pm-onboard-toast__icon" aria-hidden="true">&#x2705;</span>
    <span>You're all set! PreMeet will brief you before every meeting.</span>
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('pm-onboard-toast--visible'));

  setTimeout(() => {
    if (toast.isConnected) {
      toast.classList.remove('pm-onboard-toast--visible');
      toast.classList.add('pm-onboard-toast--exit');
      setTimeout(() => toast.remove(), 300);
    }
  }, 4000);

  markDone();
  console.log(LOG, 'Success confirmation shown, onboarding complete');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Initialise onboarding. Call once from content script. */
export async function initOnboarding(): Promise<void> {
  if (await isDone()) {
    console.log(LOG, 'Onboarding already completed');
    return;
  }

  console.log(LOG, 'First run — starting onboarding');
  active = true;
  setTimeout(() => showWelcome(), 1500);
}

/** Call when a meeting popup is detected with attendees. */
export function onMeetingDetected(): void {
  if (active) showDetectionHint();
}

/** Call when enrichment results arrive for the first time. */
export function onEnrichmentComplete(): void {
  if (active) showSuccess();
}

/** Whether onboarding is currently active. */
export function isOnboardingActive(): boolean {
  return active;
}
