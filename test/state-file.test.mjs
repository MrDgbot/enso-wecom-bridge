import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStateFile, writeStateFile } from '../src/state-file.mjs';
import { expireTasks, TASK_TTL_MS } from '../src/core.mjs';
import { emptyState } from '../src/core.mjs';

test('corrupt state is backed up and not replaced; a missing file is empty; writes are private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-state-'));
  const file = join(dir, 'state.json');
  const missing = await readStateFile(file);
  assert.equal(missing.missing, true);
  await writeFile(file, '{ this is not json');
  const broken = await readStateFile(file, 123);
  assert.equal(broken.corrupt, true);
  assert.equal(await readFile(file, 'utf8'), '{ this is not json');
  assert.match(broken.backup, /state\.json\.corrupt-123$/);
  assert.equal(await readFile(broken.backup, 'utf8'), '{ this is not json');
  await writeStateFile(file, { ok: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('queued tasks older than the TTL stop blocking replies', () => {
  const state = emptyState();
  state.tasks.push({ id: 'old', status: 'queued', sessionId: 'S', chatKey: 'group:g', updatedAt: 1, createdAt: 1 });
  state.tasks.push({ id: 'new', status: 'pending', sessionId: 'S', chatKey: 'group:g', updatedAt: 10_000, createdAt: 10_000 });
  const expired = expireTasks(state, 10_000 + TASK_TTL_MS - 1, TASK_TTL_MS);
  assert.deepEqual(expired, ['old']);
  assert.equal(state.tasks[0].status, 'failed');
  assert.match(state.tasks[0].error, /排队超时/);
  assert.equal(state.tasks[1].status, 'pending');
});
