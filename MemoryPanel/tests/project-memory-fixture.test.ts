import { describe, expect, it } from 'vitest';
import { buildProjectMemoryFixtureApp } from '../src/panel/fixtures/project-memory-fixture.js';
import { buildPanelApp } from '../src/panel/http/app.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';

const json = async (app: ReturnType<typeof buildProjectMemoryFixtureApp>, path: string, body: unknown, userKey: string, extraHeaders: Record<string, string> = {}) => {
  const response = await app.fetch(new Request(`http://fixture${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tdai-user-key': userKey, ...extraHeaders },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() as { code: number; message: string; data: any } };
};

function panelFixtureDeps(): PanelDeps {
  return {
    config: {
      server: { host: '127.0.0.1', port: 0 },
      metadataInstancesConfig: '',
      metadataRemoteTimeoutMs: 1000,
      ui: { distDir: '.' },
      log: { level: 'error', format: 'json' },
      knowledge: { baseUrl: 'http://127.0.0.1:8421', authToken: '', timeoutMs: 1000 },
      knowledgeLlmBinding: { sync: false, proxyBaseUrl: 'http://127.0.0.1:8096' },
      agentTemplateDir: '.',
      projectMemoryFixture: { enabled: true },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  } as unknown as PanelDeps;
}

describe('project memory fixture', () => {
  it('forwards panel API paths to the fixture v3 routes', async () => {
    const app = buildPanelApp(panelFixtureDeps());
    const response = await app.fetch(new Request('http://panel/api/v1/projects/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tdai-user-key': 'fixture-member-alice' },
      body: '{}',
    }));
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { projects: unknown[] } }).data.projects).toHaveLength(1);
  });

  it('keeps project visibility isolated for a member', async () => {
    const app = buildProjectMemoryFixtureApp();
    const projects = await json(app, '/v3/projects/list', {}, 'fixture-member-alice');
    expect(projects.response.status).toBe(200);
    expect(projects.body.data.projects.map((p: { project_id: string }) => p.project_id)).toEqual(['project-alpha']);

    const denied = await json(app, '/v3/project-memory/list', { project_id: 'project-beta' }, 'fixture-member-alice');
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe('PROJECT_ACCESS_DENIED');
  });

  it('limits manage to its organization while admin can cross organizations', async () => {
    const app = buildProjectMemoryFixtureApp();
    const manage = await json(app, '/v3/projects/list', {}, 'fixture-manage');
    expect(manage.body.data.projects.map((p: { project_id: string }) => p.project_id)).toEqual(['project-alpha']);
    const admin = await json(app, '/v3/projects/list', {}, 'fixture-admin');
    expect(admin.body.data.projects.map((p: { project_id: string }) => p.project_id)).toEqual(['project-alpha', 'project-beta']);
    const organizationList = await json(app, '/v3/project-memory/list', { organization_id: 'org-core' }, 'fixture-manage');
    expect(organizationList.body.data.items.every((item: { project_id: string }) => item.project_id === 'project-alpha')).toBe(true);
  });

  it('returns the same initial response for the same request sequence', async () => {
    const first = await json(buildProjectMemoryFixtureApp(), '/v3/projects/list', {}, 'fixture-member-alice');
    const second = await json(buildProjectMemoryFixtureApp(), '/v3/projects/list', {}, 'fixture-member-alice');
    expect(first.body).toEqual(second.body);
  });

  it('accepts capture idempotently and strips injected context', async () => {
    const app = buildProjectMemoryFixtureApp();
    const request = { project_id: 'project-alpha', session_id: 'session-1', task_id: 'task-1', messages: [
      { role: 'user', content: '<relevant-memories>old</relevant-memories>new fact', timestamp: '2026-09-02T00:00:00Z' },
      { role: 'assistant', content: '```ts\ninternal\n```\naccepted answer', timestamp: '2026-09-02T00:00:01Z' },
    ] };
    const first = await json(app, '/v3/project-memory/capture', request, 'fixture-member-alice', { 'idempotency-key': 'capture-1' });
    const second = await json(app, '/v3/project-memory/capture', request, 'fixture-member-alice', { 'idempotency-key': 'capture-1' });
    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    expect(second.body.data.job_id).toBe(first.body.data.job_id);
    const list = await json(app, '/v3/project-memory/list', { project_id: 'project-alpha' }, 'fixture-member-alice');
    const captured = list.body.data.items.filter((item: { memory_id: string }) => item.memory_id.includes('-capture-'));
    expect(captured).toHaveLength(2);
    expect(captured.every((item: { content: string }) => !item.content.includes('relevant-memories'))).toBe(true);
  });

  it('enforces owner writes and revision conflicts', async () => {
    const app = buildProjectMemoryFixtureApp();
    const forbidden = await json(app, '/v3/project-memory/update', { memory_id: 'memory-alpha-bob', content: 'nope', expected_revision: 1 }, 'fixture-member-alice');
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.body.code).toBe('MEMORY_EDIT_FORBIDDEN');
    const conflict = await json(app, '/v3/project-memory/update', { memory_id: 'memory-alpha-alice', content: 'new', expected_revision: 99 }, 'fixture-member-alice');
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe('MEMORY_REVISION_CONFLICT');
  });

  it('filters deleted records immediately even when cleanup fails', async () => {
    const app = buildProjectMemoryFixtureApp();
    const deleted = await json(app, '/v3/project-memory/delete', { memory_id: 'memory-alpha-alice', expected_revision: 1 }, 'fixture-member-alice', { 'idempotency-key': 'delete-1', 'x-fixture-scenario': 'cleanup-failed' });
    expect(deleted.response.status).toBe(202);
    const recall = await json(app, '/v3/project-memory/recall', { project_id: 'project-alpha', query: 'strict TypeScript' }, 'fixture-member-alice');
    expect(recall.body.data.items).toEqual([]);
    const jobs = await json(app, '/v3/project-memory/jobs/get', { job_id: deleted.body.data.job_id }, 'fixture-member-alice');
    expect(jobs.body.data.status).toBe('FAILED');
  });

  it('keeps unavailable distinct from an empty ready result and binds cursors to filters', async () => {
    const app = buildProjectMemoryFixtureApp();
    const unavailable = await json(app, '/v3/project-memory/recall', { project_id: 'project-alpha', query: 'alpha' }, 'fixture-member-alice', { 'x-fixture-scenario': 'unavailable' });
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.code).toBe('MEMORY_SERVICE_UNAVAILABLE');
    const page = await json(app, '/v3/project-memory/list', { project_id: 'project-alpha', limit: 1 }, 'fixture-member-alice');
    const invalid = await json(app, '/v3/project-memory/list', { project_id: 'project-alpha', keyword: 'changed', cursor: page.body.data.next_cursor }, 'fixture-member-alice');
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_CURSOR');
  });

  it('limits member job visibility to jobs requested by that member', async () => {
    const app = buildProjectMemoryFixtureApp();
    const capture = await json(app, '/v3/project-memory/capture', {
      project_id: 'project-alpha',
      session_id: 'bob-session',
      messages: [{ role: 'user', content: 'Bob fact', timestamp: '2026-09-02T00:00:00Z' }],
    }, 'fixture-member-bob', { 'idempotency-key': 'capture-bob' });
    expect(capture.response.status).toBe(202);

    const aliceJobs = await json(app, '/v3/project-memory/jobs/list', {}, 'fixture-member-alice');
    expect(aliceJobs.body.data.items).toEqual([]);
    const bobJobs = await json(app, '/v3/project-memory/jobs/list', {}, 'fixture-member-bob');
    expect(bobJobs.body.data.items).toHaveLength(1);
  });

  it('enforces policy scope permissions and retry idempotency headers', async () => {
    const app = buildProjectMemoryFixtureApp();
    const memberGlobal = await json(app, '/v3/project-memory/policy/get', { scope_type: 'global', scope_id: 'global' }, 'fixture-member-alice');
    expect(memberGlobal.response.status).toBe(403);
    const manageGlobal = await json(app, '/v3/project-memory/policy/get', { scope_type: 'global', scope_id: 'global' }, 'fixture-manage');
    expect(manageGlobal.response.status).toBe(403);
    const missingRetryKey = await json(app, '/v3/project-memory/jobs/retry', { job_id: 'job-1', expected_revision: 0 }, 'fixture-admin');
    expect(missingRetryKey.body.code).toBe('INVALID_REQUEST');
    const widened = await json(app, '/v3/project-memory/policy/update', { scope_type: 'project', scope_id: 'project-alpha', patch: { top_k: 9 }, expected_revision: 1 }, 'fixture-admin');
    expect(widened.response.status).toBe(422);
    expect(widened.body.code).toBe('POLICY_LIMIT_EXCEEDED');
  });

  it('requires a project for member list requests and makes job retry idempotent', async () => {
    const app = buildProjectMemoryFixtureApp();
    const missingProject = await json(app, '/v3/project-memory/list', {}, 'fixture-member-alice');
    expect(missingProject.body.code).toBe('PROJECT_CONTEXT_REQUIRED');
    const failed = await json(app, '/v3/project-memory/delete', { memory_id: 'memory-alpha-alice', expected_revision: 1 }, 'fixture-member-alice', { 'idempotency-key': 'delete-retry-seed', 'x-fixture-scenario': 'cleanup-failed' });
    const first = await json(app, '/v3/project-memory/jobs/retry', { job_id: failed.body.data.job_id, expected_revision: 0 }, 'fixture-admin', { 'idempotency-key': 'retry-1' });
    const second = await json(app, '/v3/project-memory/jobs/retry', { job_id: failed.body.data.job_id, expected_revision: 0 }, 'fixture-admin', { 'idempotency-key': 'retry-1' });
    expect(first.body).toEqual(second.body);
  });

  it('moves scope without changing content, owner, or revision', async () => {
    const app = buildProjectMemoryFixtureApp();
    const moved = await json(app, '/v3/project-memory/scope/update', {
      memory_id: 'memory-alpha-alice', target_project_id: 'project-beta', expected_revision: 1,
    }, 'fixture-admin');
    expect(moved.response.status).toBe(200);
    expect(moved.body.data.memory).toMatchObject({
      project_id: 'project-beta',
      content: 'Alpha uses strict TypeScript checks.',
      captured_by_user_id: 'user-alice',
      revision: 1,
    });
    const oldProject = await json(app, '/v3/project-memory/recall', { project_id: 'project-alpha', query: 'strict TypeScript' }, 'fixture-admin');
    const newProject = await json(app, '/v3/project-memory/recall', { project_id: 'project-beta', query: 'strict TypeScript' }, 'fixture-admin');
    expect(oldProject.body.data.items).toEqual([]);
    expect(newProject.body.data.items.map((item: { memory_id: string }) => item.memory_id)).toEqual(['memory-alpha-alice']);
  });
});
