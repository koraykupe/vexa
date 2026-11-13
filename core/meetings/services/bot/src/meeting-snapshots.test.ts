/** Deterministic proof for the Nedwerk meeting-snapshot schedule. */
import type { RemoteAudioActivitySnapshot } from './aloneness.js';
import {
  createMeetingSnapshotter,
  httpSnapshotUploader,
  resolveSnapshotCount,
  snapshotOffsetsMs,
} from './meeting-snapshots.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function fixture(count = 4, opts: { failCapture?: boolean } = {}) {
  let nowMs = 0;
  let snap: RemoteAudioActivitySnapshot = { available: true, heardRemoteAudio: false };
  const ticks: Array<() => void> = [];
  const uploads: Array<{ seq: number; at: number; bytes: number }> = [];
  const logs: string[] = [];
  let cleared = 0;
  const s = createMeetingSnapshotter({
    count,
    activity: { snapshot: () => snap },
    capture: async () => {
      if (opts.failCapture) throw new Error('page gone');
      return new Uint8Array([0xff, 0xd8, 0xff]);
    },
    upload: async (seq, at, jpeg) => { uploads.push({ seq, at, bytes: jpeg.length }); },
    now: () => nowMs,
    setInterval: (cb) => { ticks.push(cb); return ticks.length; },
    clearInterval: () => { cleared++; },
    log: (m) => logs.push(m),
  });
  return {
    s, uploads, logs,
    get cleared() { return cleared; },
    tick: async () => { for (const t of ticks) t(); await flush(); },
    at: (ms: number) => { nowMs = ms; },
    voice: (ms: number) => { nowMs = ms; snap = { ...snap, heardRemoteAudio: true, lastRemoteAudioAt: ms }; },
    ticksRegistered: () => ticks.length,
  };
}

const MIN = 60_000;

await (async () => {
  check('default count is 4', resolveSnapshotCount({}) === 4);
  check('BOT_SNAPSHOT_COUNT=0 turns it off', resolveSnapshotCount({ BOT_SNAPSHOT_COUNT: '0' }) === 0);
  check('a bad value falls back to the default', resolveSnapshotCount({ BOT_SNAPSHOT_COUNT: 'x' }) === 4);
  check('the count is capped', resolveSnapshotCount({ BOT_SNAPSHOT_COUNT: '99' }) === 10);
  check('offsets are 1/5/15/30 min', JSON.stringify(snapshotOffsetsMs(4)) === JSON.stringify([1, 5, 15, 30].map((m) => m * MIN)));
  check('extra pictures follow every 15 min', snapshotOffsetsMs(6)[5] === 60 * MIN);
})();

await (async () => {
  const f = fixture();
  await f.tick();
  check('nothing is watched before start()', f.ticksRegistered() === 0);
  f.s.start();
  f.at(10 * MIN); await f.tick();
  check('no picture while nobody has spoken', f.uploads.length === 0);
  f.voice(10 * MIN); await f.tick();
  check('no picture right at the first voice', f.uploads.length === 0);
  f.voice(11 * MIN); await f.tick();
  check('first picture one minute after the first voice', f.uploads.length === 1 && f.uploads[0].seq === 0);
  f.at(16 * MIN); await f.tick();
  check('a due picture waits while the room is quiet', f.uploads.length === 1);
  f.voice(17 * MIN); await f.tick();
  check('…and is taken at the next voice', f.uploads.length === 2 && f.uploads[1].seq === 1);
  f.voice(25 * MIN); await f.tick();
  f.voice(40 * MIN); await f.tick();
  check('third and fourth pictures are taken', f.uploads.length === 4);
  check('the watcher stops after the last picture', f.cleared === 1);
  f.voice(80 * MIN); await f.tick();
  check('never more than the count', f.uploads.length === 4);
})();

await (async () => {
  const f = fixture(2, { failCapture: true });
  f.s.start();
  f.voice(0); await f.tick();
  f.voice(2 * MIN); await f.tick();
  check('a failed screenshot is logged, not thrown', f.uploads.length === 0 && f.logs.some((l) => l.includes('failed')));
  f.s.stop(); f.s.stop();
  check('stop() is idempotent', f.cleared === 1);
})();

await (async () => {
  const f = fixture(0);
  f.s.start();
  check('count 0 never starts a timer', f.ticksRegistered() === 0);
})();

await (async () => {
  let seen: { url: string; auth: string; meta: Record<string, unknown>; file: Blob | null } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    seen = {
      url,
      auth: (init.headers as Record<string, string>).Authorization,
      meta: JSON.parse(String(form.get('metadata'))),
      file: form.get('file') as Blob | null,
    };
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const upload = httpSnapshotUploader(
    { recordingUploadUrl: 'http://meeting-api/internal/recordings/upload', connectionId: 'sess-1', internalSecret: 's3cret', meeting_id: 7 } as never,
    fakeFetch,
  );
  await upload(2, 1234, new Uint8Array([1, 2, 3]));
  const s = seen as unknown as { url: string; auth: string; meta: Record<string, unknown>; file: Blob | null };
  check('upload goes to the recording upload edge', s.url.endsWith('/internal/recordings/upload'));
  check('upload carries the internal secret', s.auth === 'Bearer s3cret');
  check('metadata names a snapshot for this session', s.meta.media_type === 'snapshot' && s.meta.session_uid === 'sess-1' && s.meta.seq === 2 && s.meta.taken_at_ms === 1234 && s.meta.media_format === 'jpg');
  check('the file is a jpeg', s.file?.type === 'image/jpeg' && s.file?.size === 3);

  const reject = httpSnapshotUploader({ recordingUploadUrl: 'http://x/u' } as never, (async () => new Response('', { status: 404 })) as unknown as typeof fetch);
  let threw = false;
  try { await reject(0, 0, new Uint8Array([1])); } catch { threw = true; }
  check('a refused upload throws (the snapshotter logs it)', threw);
})();

if (failed > 0) {
  console.log(`\n❌ ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n✅ meeting-snapshots: all checks passed');
