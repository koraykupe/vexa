/**
 * Nedwerk fork: a few still pictures of the meeting, so the people in it can be recognised later.
 *
 * The bot already sits in the call as a browser, so a picture is a page screenshot of the meeting
 * grid. It takes at most `count` of them, and only while somebody is talking: a picture of an empty
 * waiting room or of a silent grid shows nobody. Each picture is due a set time after the first
 * voice (1, 5, 15, 30 minutes by default); when it is due and the room is quiet, it waits for the
 * next voice instead.
 *
 * Pictures go to meeting-api's internal upload endpoint with `media_type: "snapshot"`, which stores
 * them beside the meeting (never in the recording) and serves them to the meeting's owner only.
 *
 * Best-effort by construction: a failed screenshot or upload is logged and dropped. Nothing here
 * may disturb the meeting, the recording or how the bot leaves.
 *
 * BOT_SNAPSHOT_COUNT sets how many pictures (default 4); 0 turns the feature off.
 */
import type { Invocation } from './config.js';
import type { RemoteAudioActivitySource } from './aloneness.js';

export const DEFAULT_SNAPSHOT_COUNT = 4;
/** Minutes after the first voice at which each picture is due. */
export const SNAPSHOT_OFFSETS_MIN: readonly number[] = [1, 5, 15, 30];
/** A picture is only taken if somebody was heard this recently. */
export const SNAPSHOT_VOICE_RECENT_MS = 20_000;
export const SNAPSHOT_POLL_MS = 5_000;
const MAX_SNAPSHOTS = 10;

export function resolveSnapshotCount(env: NodeJS.ProcessEnv): number {
  const raw = env.BOT_SNAPSHOT_COUNT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SNAPSHOT_COUNT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_SNAPSHOT_COUNT;
  return Math.min(value, MAX_SNAPSHOTS);
}

/** The minute offsets for `count` pictures: the defaults, then every 15 minutes after the last. */
export function snapshotOffsetsMs(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const min = i < SNAPSHOT_OFFSETS_MIN.length
      ? SNAPSHOT_OFFSETS_MIN[i]
      : SNAPSHOT_OFFSETS_MIN[SNAPSHOT_OFFSETS_MIN.length - 1] + 15 * (i - SNAPSHOT_OFFSETS_MIN.length + 1);
    out.push(min * 60_000);
  }
  return out;
}

export type SnapshotCapture = () => Promise<Uint8Array>;
export type SnapshotUploader = (seq: number, takenAtMs: number, jpeg: Uint8Array) => Promise<void>;

export interface MeetingSnapshotter {
  /** Start watching (call once the bot is admitted). Idempotent. */
  start(): void;
  /** Stop for good. Idempotent. */
  stop(): void;
}

export function createMeetingSnapshotter(options: {
  count: number;
  activity: RemoteAudioActivitySource;
  capture: SnapshotCapture;
  upload: SnapshotUploader;
  now?: () => number;
  pollMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (msg: string) => void;
}): MeetingSnapshotter {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => { /* silent */ });
  const setIntervalFn = options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalFn = options.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const offsets = snapshotOffsetsMs(options.count);

  let timer: unknown;
  let started = false;
  let stopped = false;
  let busy = false;
  let firstVoiceAt: number | null = null;
  let taken = 0;

  const tick = (): void => {
    if (stopped || busy || taken >= offsets.length) return;
    const at = now();
    const snap = options.activity.snapshot();
    const last = snap.lastRemoteAudioAt;
    if (!snap.heardRemoteAudio || last === undefined) return;
    if (firstVoiceAt === null) firstVoiceAt = last;
    if (at - firstVoiceAt < offsets[taken]) return;
    if (at - last > SNAPSHOT_VOICE_RECENT_MS) return;
    busy = true;
    const seq = taken;
    taken++;
    void (async () => {
      try {
        const jpeg = await options.capture();
        await options.upload(seq, at, jpeg);
        log(`snapshot ${seq + 1}/${offsets.length} stored (${jpeg.length}B)`);
      } catch (e) {
        log(`snapshot ${seq + 1}/${offsets.length} failed — skipped: ${String(e)}`);
      } finally {
        busy = false;
        if (taken >= offsets.length) stop();
      }
    })();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    start(): void {
      if (started || stopped || offsets.length === 0) return;
      started = true;
      timer = setIntervalFn(tick, options.pollMs ?? SNAPSHOT_POLL_MS);
    },
    stop,
  };
}

/** POST one picture to meeting-api's internal upload endpoint (the recording upload edge). */
export function httpSnapshotUploader(
  inv: Invocation,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 30_000,
): SnapshotUploader {
  return async (seq, takenAtMs, jpeg) => {
    const url = inv.recordingUploadUrl;
    if (!url) throw new Error('no recordingUploadUrl in the invocation');
    const form = new FormData();
    form.append('metadata', JSON.stringify({
      meeting_id: inv.meeting_id ?? 0,
      session_uid: inv.connectionId ?? '',
      media_type: 'snapshot',
      media_format: 'jpg',
      seq,
      taken_at_ms: takenAtMs,
    }));
    form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), `snapshot-${seq}.jpg`);
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${inv.internalSecret ?? ''}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`upload rejected: HTTP ${res.status}`);
  };
}
