import { describe, expect, it, vi } from 'vitest';
import { ProjectMemoryHttpClient, ProjectMemoryError } from '../../MemoryCore/openclaw-plugin/src/project-memory-client.js';
import { buildProjectMemoryFixtureApp } from '../src/panel/fixtures/project-memory-fixture.js';

describe('project memory HTTP client', () => {
  it('sends project context and mutation headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, message: 'accepted', request_id: 'req-1', data: { job_id: 'job-1' } }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const client = new ProjectMemoryHttpClient({ endpoint: 'http://fixture', apiKey: 'fixture-member-alice', fetcher });
    await client.capture({ project_id: 'project-alpha', session_id: 's1', task_id: 't1', messages: [] }, 'capture-key');
    const [, init] = fetcher.mock.calls[0];
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('capture-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({ project_id: 'project-alpha' });
  });

  it('preserves server failure code and status', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 'MEMORY_REVISION_CONFLICT', message: 'stale', request_id: 'req-2', data: null }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const client = new ProjectMemoryHttpClient({ endpoint: 'http://fixture', apiKey: 'fixture-member-alice', fetcher });
    await expect(client.update({ memory_id: 'memory-alpha-alice', content: 'x', expected_revision: 1 })).rejects.toMatchObject<ProjectMemoryError>({ code: 'MEMORY_REVISION_CONFLICT', status: 409 });
  });

  it('authenticates the plugin client against the deterministic fixture', async () => {
    const app = buildProjectMemoryFixtureApp();
    const fetcher: typeof fetch = (input, init) => app.fetch(new Request(String(input), init));
    const client = new ProjectMemoryHttpClient({ endpoint: 'http://fixture', apiKey: 'fixture-member-alice', fetcher });

    await expect(client.listProjects()).resolves.toMatchObject({ projects: [{ project_id: 'project-alpha' }] });
  });

  it('keeps capture, update, recall, and delete synchronized with the fixture', async () => {
    const app = buildProjectMemoryFixtureApp();
    const fetcher: typeof fetch = (input, init) => app.fetch(new Request(String(input), init));
    const client = new ProjectMemoryHttpClient({ endpoint: 'http://fixture', apiKey: 'fixture-member-alice', fetcher });
    const request = {
      project_id: 'project-alpha',
      session_id: 'sync-session',
      messages: [{ role: 'user' as const, content: 'A synchronized project fact', timestamp: '2026-09-02T00:01:00Z' }],
    };

    const first = await client.capture(request, 'sync-capture');
    const repeated = await client.capture(request, 'sync-capture');
    expect(repeated.job_id).toBe(first.job_id);

    const listed = await client.list({ project_id: 'project-alpha', keyword: 'synchronized project fact' });
    const captured = listed.items.find((item) => item.content === 'A synchronized project fact');
    expect(captured).toBeDefined();
    const updated = await client.update({ memory_id: captured!.memory_id, content: 'The synchronized fact was updated', expected_revision: captured!.revision });
    await expect(client.recall({ project_id: 'project-alpha', query: 'synchronized fact' })).resolves.toMatchObject({ items: [{ content: 'The synchronized fact was updated' }] });

    await client.delete({ memory_id: updated.memory.memory_id, expected_revision: updated.memory.revision }, 'sync-delete');
    await expect(client.recall({ project_id: 'project-alpha', query: 'synchronized fact' })).resolves.toMatchObject({ items: [] });
  });
});
