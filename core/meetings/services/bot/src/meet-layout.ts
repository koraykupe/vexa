/**
 * Nedwerk fork: put Google Meet in the Tiled layout before a meeting picture.
 *
 * Meet's default Auto layout puts whoever is talking in a big tile and shrinks or hides the
 * rest, so a picture taken while somebody talks shows that one person. Tiled gives every
 * participant an equal tile, which is what a picture for recognising people later needs.
 *
 * The bot's browser UI is pinned to en-US (modules/join/src/browser-args.ts), so the English
 * labels hold: More options → "Change layout" (newer builds: "Adjust view") → "Tiled".
 * Meet keeps the choice for the rest of the call, so one success is enough.
 *
 * Best-effort: every step has a short timeout, and the dialog is always closed with Escape so a
 * failed attempt never leaves a menu over the meeting.
 */

/** The part of a Playwright Page this needs (a fake in tests). */
export interface LayoutPage {
  locator(selector: string): { first(): { click(options: { timeout: number }): Promise<void> } };
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
}

export const MEET_MORE_OPTIONS = 'button[aria-label="More options"]';
export const MEET_LAYOUT_ITEM = '[role="menuitem"]:has-text("Change layout"), [role="menuitem"]:has-text("Adjust view")';
export const MEET_TILED_OPTION = '[role="dialog"] >> text=Tiled';

const STEP_TIMEOUT_MS = 3_000;

/** Switch to Tiled. Resolves true when every click landed; never throws. */
export async function setMeetTiledLayout(page: LayoutPage, log: (m: string) => void = () => {}): Promise<boolean> {
  try {
    await page.locator(MEET_MORE_OPTIONS).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator(MEET_LAYOUT_ITEM).first().click({ timeout: STEP_TIMEOUT_MS });
    await page.locator(MEET_TILED_OPTION).first().click({ timeout: STEP_TIMEOUT_MS });
    log('meet layout: tiled');
    return true;
  } catch (e) {
    log(`meet layout: could not switch to tiled — ${String(e).split('\n')[0]}`);
    return false;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    // Let Meet re-render the grid before anybody takes a picture of it.
    await page.waitForTimeout(1_000).catch(() => {});
  }
}

/** A capture that makes sure the layout is Tiled first (until one switch succeeds). */
export function withTiledLayout<T>(
  page: LayoutPage,
  capture: () => Promise<T>,
  log: (m: string) => void = () => {},
): () => Promise<T> {
  let tiled = false;
  return async () => {
    if (!tiled) tiled = await setMeetTiledLayout(page, log);
    return capture();
  };
}
