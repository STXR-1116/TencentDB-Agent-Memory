/** Small, pure rules shared by the project-memory API adapter and page. */

export type ProjectMemoryRole = 'member' | 'manage' | 'admin';

/** Map the documented v3 service route to the Panel transport prefix. */
export function panelProjectMemoryPath(servicePath: string): string {
  return servicePath.startsWith('/v3/') ? `/api/v1${servicePath.slice(3)}` : servicePath;
}

/** Backend governance controls are available only to manage/admin roles. */
export function canGovernProjectMemory(role: ProjectMemoryRole | undefined): boolean {
  return role === 'manage' || role === 'admin';
}

/** Filter changes always start a fresh server-side page. */
export function resetProjectMemoryPagination(): { cursor: null; nextCursor: null } {
  return { cursor: null, nextCursor: null };
}

/** Accept a list response only when it belongs to the latest request generation. */
export function isCurrentProjectMemoryRequest(
  currentGeneration: number,
  responseGeneration: number,
): boolean {
  return currentGeneration === responseGeneration;
}

/** Preserve server error code and HTTP status for actionable UI feedback. */
export function projectMemoryErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as { message?: string; code?: string | number; status?: number };
  return `${value.code ? `[${value.code}] ` : ''}${value.message ?? '请求失败'}${value.status ? ` (${value.status})` : ''}`;
}
