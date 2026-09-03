import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  instanceId: 'fixture-instance',
  userKey: 'fixture-manage',
  user: { user_id: 'user-manage', username: 'manage' },
};

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe('project memory web API client', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage());
    localStorage.setItem('tdai-panel.session', JSON.stringify(session));
  });

  it('uses Panel transport and mutation headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      request_id: 'req-1',
      data: { memory: { memory_id: 'memory-alpha-alice' }, event_id: 'evt-1', job_id: 'job-1', status: 'INDEX_PENDING' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const { projectMemoryApi } = await import('../../MemoryPanel/web/src/lib/api/project-memory');

    await projectMemoryApi.update({ memory_id: 'memory-alpha-alice', content: 'changed', expected_revision: 3 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/v1/project-memory/update');
    expect((init?.headers as Record<string, string>)['X-Tdai-Service-Id']).toBe('fixture-instance');
    expect((init?.headers as Record<string, string>)['X-Tdai-User-Key']).toBe('fixture-manage');
    expect((init?.headers as Record<string, string>)['If-Match']).toBe('"3"');
  });

  it('preserves a server error code from a failed mutation', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 'MEMORY_REVISION_CONFLICT', message: 'stale', request_id: 'req-2', data: null,
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const { projectMemoryApi } = await import('../../MemoryPanel/web/src/lib/api/project-memory');

    await expect(projectMemoryApi.update({ memory_id: 'memory-alpha-alice', content: 'keep draft', expected_revision: 1 }))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT', status: 409 });
  });
});
