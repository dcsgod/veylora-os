from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.config import Config  # noqa: E402
from backend.models.mock import MockProvider  # noqa: E402
from backend.services import Services  # noqa: E402

FEATURES_MJS = """import { randomUUID } from 'node:crypto';

export function routes(store) {
  return [
    { method: 'GET', path: '/api/notes', handler: async (req, res, ctx) => ctx.send(res, 200, store.list('notes')) },
    { method: 'POST', path: '/api/notes', handler: async (req, res, ctx) => {
      const body = await ctx.readJson(req);
      if (!body || typeof body.text !== 'string' || !body.text.trim()) return ctx.send(res, 422, { error: 'text required' });
      const { record } = store.put('notes', { id: randomUUID(), text: body.text.trim() });
      return ctx.send(res, 201, record);
    } },
  ];
}
"""

FEATURES_JS = """export async function mount(root) {
  const h = document.createElement('h2');
  h.textContent = 'Notes';
  const list = document.createElement('ul');
  root.append(h, list);
  const notes = await (await fetch('/api/notes')).json();
  for (const n of notes) { const li = document.createElement('li'); li.textContent = n.text; list.append(li); }
}
"""

TEST_TEMPLATE = """import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

let server, base;
before(async () => {
  server = await createServer({ dataDir: mkdtempSync(join(tmpdir(), 'f-')) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('notes are created and listed', async () => {
  const r = await fetch(`${base}/api/notes`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.status, 201);
  assert.equal((await (await fetch(`${base}/api/notes`)).json()).length, EXPECTED);
});

test('invalid notes are rejected', async () => {
  assert.equal((await fetch(`${base}/api/notes`, { method: 'POST', body: JSON.stringify({}) })).status, 422);
});
"""


def feature_files(expected_count: int = 1) -> dict:
    return {"files": [
        {"path": "src/features.mjs", "content": FEATURES_MJS},
        {"path": "public/features.js", "content": FEATURES_JS},
        {"path": "test/features.test.mjs", "content": TEST_TEMPLATE.replace("EXPECTED", str(expected_count))},
    ], "notes": "mock-generated notes feature"}


def make_responder(feature_sequence: list[dict]):
    """Return GeneratedFiles payloads in order (last one repeats); schema-shaped placeholders otherwise."""
    state = {"i": 0}

    def responder(model, messages, schema):
        title = (schema or {}).get("title")
        if title == "GeneratedFiles":
            payload = feature_sequence[min(state["i"], len(feature_sequence) - 1)]
            state["i"] += 1
            return json.dumps(payload)
        if title == "SpecRefinement":
            return json.dumps({"assumptions": ["mock assumption"], "open_questions": [], "extra_features": []})
        if title == "ReviewReport":
            return json.dumps({"summary": "mock review", "findings": []})
        return MockProvider._default(model, messages, schema)

    responder.state = state  # type: ignore[attr-defined]
    return responder


@pytest.fixture
def config(tmp_path: Path) -> Config:
    return Config(data_dir=tmp_path / "data", session_token="test-token", start_scheduler_recovery=False)


@pytest.fixture
async def services(config: Config):
    s = Services.build(config, register_default_providers=False)
    yield s
    await s.aclose()


async def attach_mock(s: Services, responder=None) -> MockProvider:
    mock = MockProvider(responder=responder)
    s.models.register(mock, max_concurrency=2)
    await s.models.sync()
    return mock


async def wait_for_project(s: Services, project_id: str, timeout_s: float = 300) -> dict:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        await asyncio.sleep(0.2)
        if not s.scheduler.is_running(project_id):
            return s.projects.get(project_id)
    raise TimeoutError(f"project {project_id} did not settle")


def by_key(s: Services, project_id: str) -> dict[str, dict]:
    return {t["key"]: t for t in s.projects.tasks(project_id)}
