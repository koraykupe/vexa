/** Deterministic proof for the Meet Tiled-layout step before a meeting picture. */
import {
  MEET_LAYOUT_ITEM,
  MEET_MORE_OPTIONS,
  MEET_TILED_OPTION,
  setMeetTiledLayout,
  withTiledLayout,
  type LayoutPage,
} from './meet-layout.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

function fakePage(missing: string | null = null) {
  const clicks: string[] = [];
  const keys: string[] = [];
  const page: LayoutPage = {
    locator: (selector) => ({
      first: () => ({
        click: async () => {
          if (selector === missing) throw new Error(`Timeout 3000ms exceeded waiting for ${selector}`);
          clicks.push(selector);
        },
      }),
    }),
    keyboard: { press: async (k) => { keys.push(k); } },
    waitForTimeout: async () => {},
  };
  return { page, clicks, keys };
}

await (async () => {
  const f = fakePage();
  const logs: string[] = [];
  const ok = await setMeetTiledLayout(f.page, (m) => logs.push(m));
  check('switches through More options → layout → Tiled', ok
    && JSON.stringify(f.clicks) === JSON.stringify([MEET_MORE_OPTIONS, MEET_LAYOUT_ITEM, MEET_TILED_OPTION]), f.clicks.join(' | '));
  check('closes the dialog afterwards', f.keys.includes('Escape'));
  check('logs the switch', logs.some((l) => l.includes('tiled')));
})();

await (async () => {
  const f = fakePage(MEET_LAYOUT_ITEM);
  const logs: string[] = [];
  const ok = await setMeetTiledLayout(f.page, (m) => logs.push(m));
  check('a missing menu item is reported, not thrown', !ok && logs.some((l) => l.includes('could not')));
  check('an open menu is still closed', f.keys.includes('Escape'));
})();

await (async () => {
  const f = fakePage();
  let shots = 0;
  const capture = withTiledLayout(f.page, async () => ++shots);
  await capture();
  await capture();
  check('the layout is switched once, then pictures are just taken', shots === 2 && f.clicks.length === 3, `clicks=${f.clicks.length}`);
})();

await (async () => {
  const f = fakePage(MEET_MORE_OPTIONS);
  let shots = 0;
  const capture = withTiledLayout(f.page, async () => ++shots);
  await capture();
  await capture();
  check('a failed switch still takes the picture and tries again next time', shots === 2);
})();

if (failed > 0) {
  console.log(`\n❌ ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n✅ meet-layout: all checks passed');
