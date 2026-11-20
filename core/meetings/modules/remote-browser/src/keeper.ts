/**
 * keeper — renew the bot account's Google web session BEFORE it expires.
 *
 * A Google Workspace edition without a session-length setting signs every web
 * session out after a fixed number of days (14 on Starter/Standard). A bot that
 * meets that moment at a meeting's start has to sign in again in the meeting's
 * first seconds — or misses the meeting. The keeper runs outside meetings (a
 * daily cron on the Vexa host, session-keeper-cli) and signs the stored session
 * out and in again once it is `maxAgeDays` old, so the expiry never arrives; and
 * it signs in again at once when it finds the session already gone.
 *
 * `keeperPlan` decides, `signInWithPassword` drives Google's sign-in pages; both
 * are exercised against a stub Page in keeper.test.ts.
 */
import type { Page } from 'playwright';

export type KeeperAction = 'none' | 'relogin';

export interface KeeperPlan {
  action: KeeperAction;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the keeper does with the session it found.
 * - signed out → sign in again now;
 * - last sign-in unknown → sign in now, so the clock has a known start;
 * - at least `maxAgeDays` old → sign out and in again before the expiry.
 */
export function keeperPlan(
  loggedIn: boolean,
  lastLoginAt: Date | null,
  now: Date,
  maxAgeDays: number,
): KeeperPlan {
  if (!loggedIn) return { action: 'relogin', reason: 'signed out' };
  if (!lastLoginAt || Number.isNaN(lastLoginAt.getTime())) {
    return { action: 'relogin', reason: 'time of the last sign-in unknown' };
  }
  const ageDays = (now.getTime() - lastLoginAt.getTime()) / DAY_MS;
  if (ageDays >= maxAgeDays) {
    return { action: 'relogin', reason: `session ${ageDays.toFixed(1)} days old (renewed at ${maxAgeDays})` };
  }
  return { action: 'none', reason: `session ${ageDays.toFixed(1)} days old` };
}

/** Where a fresh sign-in for `email` starts: Google's sign-in with the account pre-filled. */
export function googleSignInUrl(email: string): string {
  const q = new URLSearchParams({ continue: 'https://myaccount.google.com/', Email: email });
  return `https://accounts.google.com/ServiceLogin?${q.toString()}`;
}

export const GOOGLE_LOGOUT_URL = 'https://accounts.google.com/Logout';

export function isGoogleAccountsPage(url: string): boolean {
  try {
    return new URL(url).hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

const EMAIL_INPUT = 'input[type="email"]';
const PASSWORD_INPUT = 'input[type="password"][name="Passwd"], input[type="password"]';

async function visible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Answer Google's sign-in pages with the account's e-mail and password, starting
 * on a page `googleSignInUrl` (or a re-verification) put the browser on. Answers
 * exactly three things: an account-chooser tile for `email`, the e-mail field,
 * and the password field (once). Anything else — a phone prompt, a second
 * factor, a captcha, "verify it's you" — leaves the browser on
 * accounts.google.com, and the result names the page so a person knows what
 * Google asked. Synthetic input on purpose; the password never reaches a log.
 *
 * ok once the browser has left accounts.google.com.
 */
export async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
  opts: { timeoutMs?: number; stepMs?: number; refusedAfterMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const stepMs = opts.stepMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let emailSent = false;
  let passwordSent = false;
  let passwordSentAt = 0;
  const refusedAfterMs = opts.refusedAfterMs ?? 10_000;

  while (Date.now() < deadline) {
    const url = page.url();
    if (!isGoogleAccountsPage(url)) {
      return { ok: true, detail: `signed in; now on ${(() => { try { return new URL(url).hostname; } catch { return url; } })()}` };
    }
    if (!passwordSent && (await visible(page, PASSWORD_INPUT))) {
      const field = page.locator(PASSWORD_INPUT).first();
      await field.fill(password);
      await field.press('Enter');
      passwordSent = true;
      passwordSentAt = Date.now();
    } else if (!emailSent && (await visible(page, EMAIL_INPUT))) {
      const field = page.locator(EMAIL_INPUT).first();
      await field.fill(email);
      await field.press('Enter');
      emailSent = true;
    } else if (!emailSent && (await visible(page, `[data-identifier="${email}"]`))) {
      await page.locator(`[data-identifier="${email}"]`).first().click();
      emailSent = true;
    } else if (
      passwordSent &&
      Date.now() - passwordSentAt >= refusedAfterMs &&
      (await visible(page, PASSWORD_INPUT))
    ) {
      // Still on the password field well after the password was sent: Google refused it.
      return { ok: false, detail: `Google did not accept the password (${pathOf(page.url())})` };
    }
    await page.waitForTimeout(stepMs);
  }
  const where = pathOf(page.url());
  const asked = passwordSent
    ? 'Google asked for more than the password'
    : emailSent
      ? 'Google never showed the password field'
      : 'Google showed no sign-in field the keeper answers';
  return { ok: false, detail: `${asked} (${where})` };
}
