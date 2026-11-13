"""Nedwerk fork: meeting snapshots — stored beside the meeting, never a recording, owner-only."""
from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import mint_meeting_token
from meeting_api.recordings import build_router
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage

SECRET = "test-admin-token"
INTERNAL = "test-internal-secret"
USER = 7
OTHER_USER = 8
MEETING_ID = 1
OTHER_MEETING = 2
SESSION_UID = "conn-abc"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
T0 = 1_794_000_000_000


def _setup():
    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID)
    repo.seed(meeting_id=OTHER_MEETING, user_id=OTHER_USER, session_uid="conn-other")
    storage = InMemoryStorage()
    app = FastAPI()
    app.include_router(build_router(repo, storage, token_secret=SECRET))
    return repo, storage, TestClient(app)


def _post(client, *, seq=0, taken=T0, data=JPEG, session_uid=SESSION_UID, fmt="jpg", auth=None):
    token = auth or mint_meeting_token(MEETING_ID, USER, "google_meet", "abc", secret=SECRET)
    meta = {"session_uid": session_uid, "media_type": "snapshot", "media_format": fmt,
            "seq": seq, "taken_at_ms": taken}
    return client.post(
        "/internal/recordings/upload",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": (f"snapshot-{seq}.jpg", data, "image/jpeg")},
        data={"metadata": json.dumps(meta)},
    )


def _me(user=USER):
    return {"x-user-id": str(user)}


def test_snapshot_is_stored_in_its_own_keyspace_and_is_not_a_recording():
    _, storage, client = _setup()
    r = _post(client)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "stored"
    assert list(storage.blobs) == [f"snapshots/{USER}/{MEETING_ID}/{T0:013d}-00.jpg"]
    assert client.get("/recordings", headers=_me()).json()["recordings"] == []


def test_internal_secret_is_accepted(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL)
    _, _, client = _setup()
    assert _post(client, auth=INTERNAL).status_code == 200


def test_bad_uploads_are_refused_and_store_nothing():
    _, storage, client = _setup()
    assert _post(client, data=b"not a jpeg").status_code == 422
    assert _post(client, fmt="png").status_code == 422
    assert _post(client, seq=-1).status_code == 422
    assert _post(client, seq="0").status_code == 422
    assert _post(client, taken=123).status_code == 422
    assert _post(client, session_uid="nope").status_code == 404
    other_token = mint_meeting_token(OTHER_MEETING, OTHER_USER, "google_meet", "x", secret=SECRET)
    assert _post(client, auth=other_token).status_code == 404
    assert storage.blobs == {}


def test_owner_lists_reads_and_deletes_snapshots_in_time_order():
    _, storage, client = _setup()
    _post(client, seq=1, taken=T0 + 240_000)
    _post(client, seq=0, taken=T0)
    listing = client.get(f"/snapshots/{MEETING_ID}", headers=_me())
    assert listing.status_code == 200
    items = listing.json()["snapshots"]
    assert [i["id"] for i in items] == [f"{T0:013d}-00", f"{T0 + 240_000:013d}-01"]
    assert items[0]["url"] == f"/snapshots/{MEETING_ID}/{T0:013d}-00"
    assert items[0]["taken_at"].endswith("Z")

    img = client.get(items[0]["url"], headers=_me())
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/jpeg"
    assert img.content == JPEG
    assert "no-store" in img.headers["cache-control"]

    d = client.delete(f"/snapshots/{MEETING_ID}", headers=_me())
    assert d.json()["deleted"] == 2
    assert storage.blobs == {}
    assert client.get(f"/snapshots/{MEETING_ID}", headers=_me()).json()["snapshots"] == []


def test_another_user_sees_nothing():
    _, storage, client = _setup()
    _post(client)
    sid = f"{T0:013d}-00"
    assert client.get(f"/snapshots/{MEETING_ID}", headers=_me(OTHER_USER)).status_code == 404
    assert client.get(f"/snapshots/{MEETING_ID}/{sid}", headers=_me(OTHER_USER)).status_code == 404
    assert client.delete(f"/snapshots/{MEETING_ID}", headers=_me(OTHER_USER)).status_code == 404
    assert client.get(f"/snapshots/999", headers=_me()).status_code == 404
    assert len(storage.blobs) == 1


def test_snapshot_id_cannot_escape_the_meeting_prefix():
    _, _, client = _setup()
    _post(client)
    assert client.get(f"/snapshots/{MEETING_ID}/..%2F..%2Fx", headers=_me()).status_code == 404
    assert client.get(f"/snapshots/{MEETING_ID}/123", headers=_me()).status_code == 404
    assert client.get(f"/snapshots/{MEETING_ID}/{T0:013d}-05", headers=_me()).status_code == 404


def test_reads_need_an_identity():
    _, _, client = _setup()
    assert client.get(f"/snapshots/{MEETING_ID}").status_code == 401
