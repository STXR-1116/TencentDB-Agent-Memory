import { describe, expect, it } from 'vitest';
import {
  panelProjectMemoryPath,
  canGovernProjectMemory,
  isCurrentProjectMemoryRequest,
  resetProjectMemoryPagination,
  projectMemoryErrorText,
} from '../../MemoryPanel/web/src/lib/project-memory-contract.js';

describe('project memory web contract', () => {
  it('maps service v3 paths through the Panel API prefix', () => {
    expect(panelProjectMemoryPath('/v3/projects/list')).toBe('/api/v1/projects/list');
    expect(panelProjectMemoryPath('/v3/project-memory/list')).toBe('/api/v1/project-memory/list');
  });

  it('allows governance writes only for manage and admin roles', () => {
    expect(canGovernProjectMemory('member')).toBe(false);
    expect(canGovernProjectMemory('manage')).toBe(true);
    expect(canGovernProjectMemory('admin')).toBe(true);
    expect(canGovernProjectMemory(undefined)).toBe(false);
  });

  it('resets both cursors when filters change', () => {
    expect(resetProjectMemoryPagination()).toEqual({ cursor: null, nextCursor: null });
  });

  it('rejects responses from an older list request generation', () => {
    expect(isCurrentProjectMemoryRequest(3, 2)).toBe(false);
    expect(isCurrentProjectMemoryRequest(3, 3)).toBe(true);
  });

  it('keeps the server error code in the visible message', () => {
    expect(projectMemoryErrorText({ code: 'MEMORY_REVISION_CONFLICT', message: 'stale', status: 409 }))
      .toBe('[MEMORY_REVISION_CONFLICT] stale (409)');
  });
});
