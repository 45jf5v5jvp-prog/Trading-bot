from datetime import datetime

from assistant.extract import batches, build_prompt, to_proposals
from assistant.models import SourceItem
from assistant.runner import latest_slot, scan_due

NOW = datetime(2026, 9, 29, 14, 5).astimezone()


def item(ref="email:INBOX:1", body="hello"):
    return SourceItem("email", ref, "Dr. Patel <dr@example.com>", NOW, "Appointment", body)


def test_to_proposals_parses_dates_and_filters():
    raw = [
        {"source_ref": "email:INBOX:1", "title": "Dentist", "kind": "event", "date": "2026-10-02",
         "time": "15:00", "duration_minutes": 60, "location": "", "why": "x", "confidence": "high"},
        {"source_ref": "email:INBOX:1", "title": "Return form", "kind": "task", "date": "2026-10-05",
         "time": None, "duration_minutes": None, "location": "", "why": "x", "confidence": "medium"},
        {"source_ref": "email:INBOX:1", "title": "Call back", "kind": "task", "date": None,
         "time": None, "duration_minutes": None, "location": "", "why": "x", "confidence": "medium"},
        {"source_ref": "email:INBOX:1", "title": "Maybe lunch", "kind": "event", "date": "2026-10-06",
         "time": "12:00", "duration_minutes": None, "location": "", "why": "x", "confidence": "low"},
        {"source_ref": "email:INBOX:1", "title": "Old thing", "kind": "event", "date": "2026-09-01",
         "time": "10:00", "duration_minutes": None, "location": "", "why": "x", "confidence": "high"},
        {"source_ref": "email:INBOX:999", "title": "Made up ref", "kind": "task", "date": None,
         "time": None, "duration_minutes": None, "location": "", "why": "x", "confidence": "high"},
    ]
    out = to_proposals(raw, [item()], NOW, "medium")
    assert [p.title for p in out] == ["Dentist", "Return form", "Call back"]
    dentist, form, call = out
    assert (dentist.start.hour, dentist.all_day, dentist.duration_minutes) == (15, False, 60)
    assert form.all_day and form.start.day == 5
    assert call.start is None
    assert dentist.source_label == "Email from Dr. Patel <dr@example.com>: Appointment"


def test_batches_split_large_input():
    items = [item(f"email:INBOX:{i}", "x" * 20_000) for i in range(5)]
    groups = batches(items)
    assert len(groups) == 3  # 60k chars per batch -> 2 + 2 + 1
    assert sum(len(g) for g in groups) == 5


def test_prompt_marks_items_and_lists_existing():
    prompt = build_prompt([item(body="See you Thursday")], NOW, [], ["Pay rent"])
    assert '<item ref="email:INBOX:1"' in prompt
    assert "See you Thursday" in prompt
    assert "- Pay rent" in prompt


def test_scan_schedule():
    times = ["08:00", "11:00", "14:00", "17:00", "20:00"]
    assert latest_slot(NOW, times).hour == 14
    assert scan_due(NOW, times, None)
    assert scan_due(NOW, times, NOW.replace(hour=13, minute=0))
    assert not scan_due(NOW, times, NOW.replace(hour=14, minute=1))
    early = NOW.replace(hour=6, minute=0)
    assert latest_slot(early, times).day == NOW.day - 1  # yesterday 20:00


def test_extractor_request_shape_and_parsing():
    import json

    import httpx2 as httpx

    import anthropic
    from assistant.extract import Extractor

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["beta"] = request.headers.get("anthropic-beta", "")
        answer = {"suggestions": [{
            "source_ref": "email:INBOX:1", "title": "Dentist", "kind": "event",
            "date": "2026-10-02", "time": "15:00", "duration_minutes": 60,
            "location": "", "why": "confirmed", "confidence": "high"}]}
        return httpx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": json.dumps(answer)}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        })

    ex = Extractor("test-key", "claude-opus-5-5")
    ex.client = anthropic.Anthropic(
        api_key="test-key", http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    out = ex.extract([item()], NOW, [], [])
    assert [p.title for p in out] == ["Dentist"]
    body = seen["body"]
    assert body["model"] == "claude-opus-5-5"
    assert body["fallbacks"] == "default"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in body
    assert "server-side-fallback-2026-07-01" in seen["beta"]
