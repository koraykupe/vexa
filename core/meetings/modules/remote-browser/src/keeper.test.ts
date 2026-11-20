/**
 * keeper — the renewal decision and the sign-in driver, against a stub Page
 * (no browser, no network). Same shape as auth.smoke.test.ts (tsx + exit code).
 *
 *  1. keeperPlan: signed out / unknown age / at the renewal age → relogin;
 *     younger → none.
 *  2. signInWithPassword walks Google's pages: e-mail → password → off
 *     accounts.google.com is ok; the account-chooser tile is clicked; a page it
 *     does not answer (phone prompt) and a refused password fail, naming the
 *     page; the password is typed once and never appears in the result.
 */
import type { Page } from 'playwright';
import { keeperPlan, signInWithPassword, googleSignInUrl } from './keeper';

const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

// ── 1. keeperPlan ───────────────────────────────────────────────────────────
const NOW = new Date('2026-12-03T06:30:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
check(keeperPlan(false, daysAgo(1), NOW, 13).action === 'relogin', 'signed out → relogin');
check(keeperPlan(true, null, NOW, 13).action === 'relogin', 'unknown last sign-in → relogin');
check(keeperPlan(true, daysAgo(13), NOW, 13).action === 'relogin', '13 days old → relogin');
check(keeperPlan(true, daysAgo(12.9), NOW, 13).action === 'none', '12.9 days old → none');
check(keeperPlan(true, daysAgo(0.1), NOW, 13).action === 'none', 'fresh → none');
check(googleSignInUrl('notetaker@nedwerk.eu').includes('Email=notetaker%40nedwerk.eu'), 'sign-in URL pre-fills the account');

// ── 2. signInWithPassword against a scripted Google ─────────────────────────
type Screen = { url: string; fields: string[] };
/** A tiny Google: each screen shows some fields; an answer moves to the next screen. */
function google(screens: Screen[], onPassword: (pw: string) => number | null) {
  let i = 0;
  const typed: string[] = [];
  const has = (sel: string) => {
    const f = screens[i].fields;
    if (sel.includes('type="password"')) return f.includes('password');
    if (sel.includes('type="email"')) return f.includes('email');
    if (sel.startsWith('[data-identifier=')) return f.includes('chooser');
    return false;
  };
  const page = {
    url: () => screens[i].url,
    waitForTimeout: async () => {},
    locator: (sel: string) => ({
      first: () => ({
        isVisible: async () => has(sel),
        fill: async (v: string) => { typed.push(sel.includes('password') ? `pw:${v}` : `email:${v}`); },
        press: async () => {
          const last = typed[typed.length - 1];
          if (last.startsWith('pw:')) { const next = onPassword(last.slice(3)); if (next !== null) i = next; }
          else i += 1;
        },
        click: async () => { typed.push('chooser'); i += 1; },
      }),
    }),
  };
  return { page: page as unknown as Page, typed };
}

const EMAIL = 'notetaker@nedwerk.eu';
const PW = 's3cret-pw';
const ACC = 'https://accounts.google.com';

(async () => {
  // e-mail → password → myaccount
  {
    const g = google(
      [{ url: `${ACC}/v3/signin/identifier`, fields: ['email'] },
       { url: `${ACC}/v3/signin/challenge/pwd`, fields: ['password'] },
       { url: 'https://myaccount.google.com/', fields: [] }],
      (pw) => (pw === PW ? 2 : null),
    );
    const r = await signInWithPassword(g.page, EMAIL, PW, { timeoutMs: 2000, stepMs: 0 });
    check(r.ok, `e-mail+password flow → ok (got ${r.detail})`);
    check(g.typed.filter((t) => t.startsWith('pw:')).length === 1, 'password typed exactly once');
    check(!r.detail.includes(PW), 'password never in the result');
  }
  // account chooser → password → myaccount
  {
    const g = google(
      [{ url: `${ACC}/v3/signin/accountchooser`, fields: ['chooser'] },
       { url: `${ACC}/v3/signin/challenge/pwd`, fields: ['password'] },
       { url: 'https://myaccount.google.com/', fields: [] }],
      (pw) => (pw === PW ? 2 : null),
    );
    const r = await signInWithPassword(g.page, EMAIL, PW, { timeoutMs: 2000, stepMs: 0 });
    check(r.ok && g.typed[0] === 'chooser', 'account-chooser tile clicked, then ok');
  }
  // password → phone prompt (not answered) → fails naming the page
  {
    const g = google(
      [{ url: `${ACC}/v3/signin/challenge/pwd`, fields: ['password'] },
       { url: `${ACC}/v3/signin/challenge/ipp`, fields: [] }],
      () => 1,
    );
    const r = await signInWithPassword(g.page, EMAIL, PW, { timeoutMs: 200, stepMs: 0 });
    check(!r.ok && r.detail.includes('/challenge/ipp') && r.detail.includes('more than the password'),
      `phone prompt → fails naming it (got ${r.detail})`);
    check(!r.detail.includes(PW), 'password never in a failure');
  }
  // wrong password: the field stays → refused
  {
    const g = google([{ url: `${ACC}/v3/signin/challenge/pwd`, fields: ['password'] }], () => null);
    const r = await signInWithPassword(g.page, EMAIL, 'wrong', { timeoutMs: 2000, stepMs: 0, refusedAfterMs: 0 });
    check(!r.ok && r.detail.includes('did not accept'), `refused password → fails (got ${r.detail})`);
    check(g.typed.filter((t) => t.startsWith('pw:')).length === 1, 'refused password not retried');
  }
  // nothing to answer at all → fails
  {
    const g = google([{ url: `${ACC}/signin/rejected`, fields: [] }], () => null);
    const r = await signInWithPassword(g.page, EMAIL, PW, { timeoutMs: 100, stepMs: 0 });
    check(!r.ok && r.detail.includes('no sign-in field'), `unknown page → fails (got ${r.detail})`);
  }

  if (fails.length) {
    console.error(`keeper.test: ${fails.length} FAILED\n - ${fails.join('\n - ')}`);
    process.exit(1);
  }
  console.log('keeper.test: all passed');
})();
