import { describe, expect, it } from 'vitest';
import {
  captureProjectMemory,
  isCurrentProjectResolution,
  nextProjectResolutionEpoch,
  prepareProjectCaptureMessages,
  recallProjectMemory,
} from '../../MemoryCore/openclaw-plugin/src/hooks/project-memory.js';
import { ProjectMemoryError } from '../../MemoryCore/openclaw-plugin/src/project-memory-client.js';

describe('project memory capture hook', () => {
  it('captures only messages appended after the turn start', () => {
    const messages = prepareProjectCaptureMessages(
      [
        { role: 'user', content: 'old question', timestamp: 1_000 },
        { role: 'assistant', content: 'old answer', timestamp: 1_001 },
        { role: 'user', content: '<project-memory-reference>old fact</project-memory-reference>new question', timestamp: 2_000 },
        { role: 'assistant', content: 'new answer', timestamp: 2_001 },
      ],
      'new question',
      2,
    );

    expect(messages.map((message) => message.content)).toEqual(['new question', 'new answer']);
  });

  it('does not fall back to session history when the turn boundary is invalid', () => {
    expect(prepareProjectCaptureMessages(
      [{ role: 'user', content: 'historical', timestamp: 1_000 }],
      undefined,
      99,
    )).toEqual([]);
  });

  it('does not capture session history without a turn boundary or cursor', () => {
    expect(prepareProjectCaptureMessages([
      { role: 'user', content: 'historical', timestamp: 1_000 },
      { role: 'assistant', content: 'historical answer', timestamp: 1_001 },
    ])).toEqual([]);
  });

  it('captures a Pi turn when the host supplies its pre-turn message count', () => {
    expect(prepareProjectCaptureMessages([
      { role: 'user', content: 'old', timestamp: 1_000 },
      { role: 'user', content: 'new', timestamp: 2_000 },
      { role: 'assistant', content: 'answer', timestamp: 2_001 },
    ], 'new', 1).map((message) => message.content)).toEqual(['new', 'answer']);
  });

  it('does not let one session invalidate another session resolution', () => {
    const epochs = new Map<string, number>();
    const firstA = nextProjectResolutionEpoch(epochs, 'session-a');
    const firstB = nextProjectResolutionEpoch(epochs, 'session-b');
    nextProjectResolutionEpoch(epochs, 'session-a');

    expect(isCurrentProjectResolution(epochs, 'session-a', firstA)).toBe(false);
    expect(isCurrentProjectResolution(epochs, 'session-b', firstB)).toBe(true);
  });

  it('reports service outage without turning it into an empty ready result', async () => {
    const client = {
      recall: async () => { throw new Error('503 MEMORY_SERVICE_UNAVAILABLE'); },
    };
    const result = await recallProjectMemory(client as never, {
      project: { project_id: 'project-alpha', team_id: 'team-core', name: 'Alpha', role: 'member' },
    }, 'query');
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.items).toEqual([]);
    expect(result.error).toContain('503');
  });

  it('keeps the server code and status in plugin failure details', async () => {
    const client = {
      recall: async () => { throw new ProjectMemoryError(403, 'PROJECT_ACCESS_DENIED', 'denied'); },
    };
    const result = await recallProjectMemory(client as never, {
      project: { project_id: 'project-alpha', team_id: 'team-core', name: 'Alpha', role: 'member' },
    }, 'query');
    expect(result.error).toBe('403 PROJECT_ACCESS_DENIED denied');
  });

  it('keeps capture failure non-blocking and reports acceptance false', async () => {
    const client = {
      capture: async () => { throw new Error('503 MEMORY_SERVICE_UNAVAILABLE'); },
    };
    const result = await captureProjectMemory(client as never, {
      project: { project_id: 'project-alpha', team_id: 'team-core', name: 'Alpha', role: 'member' },
    }, { session_id: 'session-1', messages: [] }, 'capture-1');
    expect(result).toEqual({ accepted: false, error: '503 MEMORY_SERVICE_UNAVAILABLE' });
  });
});
