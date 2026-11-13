"""Nedwerk fork: meeting snapshots — the few still pictures a bot takes of the meeting grid.

A snapshot is NOT a recording. It rides the bot's internal upload edge (``media_type: "snapshot"``)
like a captured-signal tape does, and like a tape it never folds into ``meeting.data['recordings']``:
it lives only in object storage, under its own keyspace, one object per picture::

    snapshots/{owner}/{meeting_id}/{taken_at_ms:013d}-{seq:02d}.jpg

The key sorts by time, carries everything a listing needs, and needs no JSONB bookkeeping.
Reads and the delete are scoped to the meeting's owner (``owner_of``) — an unknown or foreign
meeting answers exactly like an empty one would not: 404.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from ..obs import log_event
from .ports import RecordingRepo, Storage
from .service import SessionNotFound

SNAPSHOT_MEDIA_TYPE = "snapshot"
SNAPSHOT_MEDIA_FORMAT = "jpg"
#: A viewport JPEG at quality 70 is ~100-300 KB; this bound only stops abuse of the edge.
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
MAX_SNAPSHOT_SEQ = 99

SNAPSHOT_ID_RE = re.compile(r"^\d{13}-\d{2}$")


class InvalidSnapshot(Exception):
    """A snapshot upload that is not one small JPEG with a sane seq/time → 422."""


class MeetingNotOwned(Exception):
    """The meeting does not exist or is not the caller's → 404."""


def snapshot_prefix(*, owner: int, meeting_id: int) -> str:
    return f"snapshots/{owner}/{meeting_id}/"


def snapshot_key(*, owner: int, meeting_id: int, taken_at_ms: int, seq: int) -> str:
    return f"{snapshot_prefix(owner=owner, meeting_id=meeting_id)}{taken_at_ms:013d}-{seq:02d}.jpg"


async def upload_snapshot(
    repo: RecordingRepo,
    storage: Storage,
    *,
    token_meeting_id: Optional[int],
    session_uid: str,
    data: bytes,
    seq: object,
    taken_at_ms: object,
    media_format: str = SNAPSHOT_MEDIA_FORMAT,
) -> dict:
    if media_format != SNAPSHOT_MEDIA_FORMAT:
        raise InvalidSnapshot(f"snapshot format must be jpg, got {media_format!r}")
    if not isinstance(seq, int) or isinstance(seq, bool) or not 0 <= seq <= MAX_SNAPSHOT_SEQ:
        raise InvalidSnapshot(f"snapshot seq must be an integer 0..{MAX_SNAPSHOT_SEQ}")
    if not isinstance(taken_at_ms, int) or isinstance(taken_at_ms, bool) \
            or not 10**12 <= taken_at_ms < 10**13:
        raise InvalidSnapshot("snapshot taken_at_ms must be epoch milliseconds")
    if not data or len(data) > MAX_SNAPSHOT_BYTES:
        raise InvalidSnapshot(f"snapshot must be 1..{MAX_SNAPSHOT_BYTES} bytes")
    if not data.startswith(b"\xff\xd8\xff"):
        raise InvalidSnapshot("snapshot is not a JPEG")

    session = await repo.find_session(session_uid)
    if session is None:
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")
    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")

    owner = await repo.owner_of(meeting_id)
    key = snapshot_key(owner=owner or 0, meeting_id=meeting_id, taken_at_ms=taken_at_ms, seq=seq)
    await storage.upload(key, data, content_type="image/jpeg")
    log_event(
        "snapshot_stored", audience="operator", span="recordings.snapshot",
        user_id=owner, meeting_id=str(meeting_id),
        fields={"session_uid": session_uid, "seq": seq, "bytes": len(data)},
    )
    return {"status": "stored", "meeting_id": meeting_id, "seq": seq, "bytes": len(data)}


async def _owned_prefix(repo: RecordingRepo, *, user_id: int, meeting_id: int) -> str:
    owner = await repo.owner_of(meeting_id)
    if owner is None or owner != user_id:
        raise MeetingNotOwned(f"meeting {meeting_id} not found")
    return snapshot_prefix(owner=owner, meeting_id=meeting_id)


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


async def list_snapshots(
    repo: RecordingRepo, storage: Storage, *, user_id: int, meeting_id: int,
) -> list[dict]:
    prefix = await _owned_prefix(repo, user_id=user_id, meeting_id=meeting_id)
    out: list[dict] = []
    for item in await storage.list_detailed(prefix):
        key = str(item.get("key") or "")
        name = key[len(prefix):]
        stem = name[:-4] if name.endswith(".jpg") else ""
        if not SNAPSHOT_ID_RE.match(stem):
            continue
        taken_at_ms = int(stem.split("-", 1)[0])
        out.append({
            "id": stem,
            "taken_at": _iso(taken_at_ms),
            "bytes": item.get("size"),
            "url": f"/snapshots/{meeting_id}/{stem}",
        })
    out.sort(key=lambda s: s["id"])
    return out


async def get_snapshot(
    repo: RecordingRepo, storage: Storage, *, user_id: int, meeting_id: int, snapshot_id: str,
) -> Optional[bytes]:
    if not SNAPSHOT_ID_RE.match(snapshot_id):
        return None
    prefix = await _owned_prefix(repo, user_id=user_id, meeting_id=meeting_id)
    key = f"{prefix}{snapshot_id}.jpg"
    if not await storage.exists(key):
        return None
    return await storage.get(key)


async def delete_snapshots(
    repo: RecordingRepo, storage: Storage, *, user_id: int, meeting_id: int,
) -> int:
    prefix = await _owned_prefix(repo, user_id=user_id, meeting_id=meeting_id)
    keys = await storage.list(prefix)
    for key in keys:
        await storage.delete(key)
    if keys:
        log_event(
            "snapshots_deleted", audience="operator", span="recordings.snapshot",
            user_id=user_id, meeting_id=str(meeting_id), fields={"count": len(keys)},
        )
    return len(keys)
