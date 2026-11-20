/**
 * session-keeper-cli — the daily, meeting-free renewal of the authenticated bot's
 * Google session (keeper.ts says why). Run by `deploy/compose/session-keeper.sh`
 * from the host's cron, in the bot image, under Xvfb, when no meeting bot runs.
 *
 * Flow: restore the stored session (the deployment's userdata prefix) → is it
 * signed in, and how old is the last sign-in (SESSION_STATE_FILE)? → `keeperPlan`
 * → on `relogin`: sign out, sign in with BOT_GOOGLE_EMAIL + BOT_GOOGLE_PASSWORD,
 * confirm with `validateLoggedIn`, upload the session, record the sign-in time.
 *
 * Env:
 *   BOT_USERDATA_S3_PATH · BOT_S3_ENDPOINT · BOT_S3_BUCKET · BOT_S3_ACCESS_KEY · BOT_S3_SECRET_KEY
 *                          the same userdata the bots restore (required)
 *   BOT_GOOGLE_EMAIL       the bot account (required for a sign-in)
 *   BOT_GOOGLE_PASSWORD    its password (required for a sign-in; never logged)
 *   SESSION_STATE_FILE     JSON with the last sign-in time (default /state/session.json)
 *   SESSION_MAX_AGE_DAYS   renew at this age (default 13: a day before a 14-day expiry)
 *
 * Output: the last line is `[session-keeper] RESULT {json}` — ok, action, reason,
 * detail, lastLoginAt — for the host script to forward. Exit 0 = the session works
 * (renewed or still fresh); 1 = it does not, or could not be checked.
 */
import * as fs from 'fs';
import * as path from 'path';
import { launchPersistentBrowser } from './browser';
import { getAuthenticatedBrowserArgs } from './args';
import { validateLoggedIn } from './validate';
import {
  cleanStaleLocks,
  ensureBrowserDataDir,
  makeEphemeralProfileDir,
  removeProfileDir,
  syncBrowserDataFromS3,
  syncBrowserDataToS3,
  type S3Config,
} from './session-store';
import { GOOGLE_LOGOUT_URL, googleSignInUrl, keeperPlan, signInWithPassword, type KeeperAction, type KeeperPlan } from './keeper';

interface KeeperResult {
  ok: boolean;
  action: KeeperAction | 'error';
  reason: string;
  detail: string;
  lastLoginAt: string | null;
}

function readLastLogin(file: string): Date | null {
  try {
    const at = (JSON.parse(fs.readFileSync(file, 'utf8')) as { lastLoginAt?: unknown }).lastLoginAt;
    const d = typeof at === 'string' ? new Date(at) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

async function run(): Promise<KeeperResult> {
  const stateFile = process.env.SESSION_STATE_FILE || '/state/session.json';
  const maxAgeDays = Number(process.env.SESSION_MAX_AGE_DAYS) > 0 ? Number(process.env.SESSION_MAX_AGE_DAYS) : 13;
  const email = (process.env.BOT_GOOGLE_EMAIL || '').trim();
  const password = process.env.BOT_GOOGLE_PASSWORD || '';
  const s3: S3Config = {
    userdataS3Path: process.env.BOT_USERDATA_S3_PATH || undefined,
    s3Endpoint: process.env.BOT_S3_ENDPOINT || undefined,
    s3Bucket: process.env.BOT_S3_BUCKET || undefined,
    s3AccessKey: process.env.BOT_S3_ACCESS_KEY || undefined,
    s3SecretKey: process.env.BOT_S3_SECRET_KEY || undefined,
  };
  let lastLoginAt = readLastLogin(stateFile);
  const fail = (reason: string, detail: string): KeeperResult =>
    ({ ok: false, action: 'error', reason, detail, lastLoginAt: lastLoginAt?.toISOString() ?? null });

  if (!(s3.userdataS3Path && s3.s3Endpoint && s3.s3Bucket)) {
    return fail('not configured', 'BOT_USERDATA_S3_PATH / BOT_S3_ENDPOINT / BOT_S3_BUCKET missing');
  }

  const profileDir = makeEphemeralProfileDir();
  try {
    ensureBrowserDataDir(profileDir);
    syncBrowserDataFromS3(s3, profileDir);
    cleanStaleLocks(profileDir);

    const { context, page } = await launchPersistentBrowser({ dataDir: profileDir, args: getAuthenticatedBrowserArgs() });
    let uploadNeeded = false;
    let plan: KeeperPlan = { action: 'none', reason: 'not checked' };
    let detail = '';
    try {
      const before = await validateLoggedIn(page, 'google');
      const now = new Date();
      plan = keeperPlan(before.loggedIn, lastLoginAt, now, maxAgeDays);
      console.log(`[session-keeper] signedIn=${before.loggedIn} lastLoginAt=${lastLoginAt?.toISOString() ?? 'unknown'} → ${plan.action} (${plan.reason})`);
      detail = before.detail ?? '';

      if (plan.action === 'relogin') {
        if (!email || !password) {
          return fail(plan.reason, 'BOT_GOOGLE_EMAIL or BOT_GOOGLE_PASSWORD is not set; cannot sign in');
        }
        if (before.loggedIn) {
          try { await page.goto(GOOGLE_LOGOUT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch { /* checked below */ }
          await page.waitForTimeout(3000);
        }
        try { await page.goto(googleSignInUrl(email), { waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch { /* checked below */ }
        await page.waitForTimeout(2000);
        const signIn = await signInWithPassword(page, email, password);
        if (!signIn.ok) {
          try { await page.screenshot({ path: path.join(path.dirname(stateFile), 'session-keeper-failed.png'), fullPage: true }); } catch { /* best effort */ }
          return fail(plan.reason, signIn.detail);
        }
        const after = await validateLoggedIn(page, 'google');
        if (!after.loggedIn) return fail(plan.reason, `signed in, but not confirmed: ${after.detail}`);
        lastLoginAt = now;
        uploadNeeded = true;
        detail = signIn.detail;
      }
    } finally {
      await context.close().catch(() => {}); // flush the profile before it is uploaded
    }

    if (uploadNeeded) {
      const uploaded = syncBrowserDataToS3(s3, profileDir);
      if (uploaded === 0) return fail(plan.reason, 'signed in, but the session could not be saved (0 items uploaded)');
      writeState(stateFile, { lastLoginAt: lastLoginAt!.toISOString() });
    }
    return { ok: true, action: plan.action, reason: plan.reason, detail, lastLoginAt: lastLoginAt?.toISOString() ?? null };
  } finally {
    removeProfileDir(profileDir);
  }
}

run()
  .catch((e): KeeperResult => ({ ok: false, action: 'error', reason: 'crashed', detail: String(e).slice(0, 300), lastLoginAt: null }))
  .then((result) => {
    console.log(`[session-keeper] RESULT ${JSON.stringify(result)}`);
    process.exit(result.ok ? 0 : 1);
  });
