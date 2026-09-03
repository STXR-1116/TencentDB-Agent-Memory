/** Project-scoped team memory API. The server remains the only fact source. */
import { getPanelSession } from '../panelSession';
import { ApiError, request } from './base';
import { panelProjectMemoryPath, type ProjectMemoryRole } from '../project-memory-contract';

export type { ProjectMemoryRole } from '../project-memory-contract';
export interface ProjectSummary {
  project_id: string;
  team_id: string;
  organization_id?: string;
  name: string;
  role: ProjectMemoryRole;
}
export interface ProjectMemoryRecord {
  memory_id: string;
  team_id: string;
  project_id: string;
  content: string;
  layer: 'L1';
  captured_by_user_id: string;
  created_at: string;
  updated_at: string;
  revision: number;
  status: 'ACTIVE' | 'DELETED';
  importance: number;
  recall_count: number;
  last_recalled_at: string | null;
  source_kind: string;
}
export interface ProjectMemoryJob {
  job_id: string;
  event_id: string;
  kind: string;
  project_id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  retry_count: number;
  retryable: boolean;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
}
export interface ProjectMemoryAudit {
  audit_id: string;
  operation: string;
  operated_by_user_id: string;
  role: ProjectMemoryRole;
  memory_id: string | null;
  project_id: string | null;
  old_project_id?: string;
  new_project_id?: string;
  result: string;
  error_code?: string | null;
}

async function call<T>(
  path: string,
  input: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const response = await request<{
    code: string | number;
    message: string;
    request_id: string;
    data: T;
  }>('POST', panelProjectMemoryPath(path), input, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
    ...extra,
  });
  if (response.code !== 0) {
    throw new ApiError(400, response.message, '', {
      code: response.code,
      requestId: response.request_id,
      rawMessage: response.message,
    });
  }
  return response.data;
}

const prefix = '/v3/project-memory';
const idempotency = (operation: string, id: string) => `${operation}-${id}-${Date.now()}`;

export const projectMemoryApi = {
  projects: () => call<{ projects: ProjectSummary[] }>('/v3/projects/list', {}),
  list: (input: {
    project_id?: string;
    organization_id?: string;
    team_id?: string;
    cursor?: string | null;
    limit?: number;
    keyword?: string;
    status?: string;
    captured_by_user_id?: string;
  }) =>
    call<{ items: ProjectMemoryRecord[]; next_cursor: string | null; total_estimate: number }>(
      `${prefix}/list`,
      input,
    ),
  get: (memoryId: string) => call<ProjectMemoryRecord>(`${prefix}/get`, { memory_id: memoryId }),
  update: (input: { memory_id: string; content: string; expected_revision: number }) =>
    call<{ memory: ProjectMemoryRecord; event_id: string; job_id: string; status: string }>(
      `${prefix}/update`,
      input,
      { 'If-Match': `"${input.expected_revision}"` },
    ),
  delete: (input: { memory_id: string; expected_revision: number }) =>
    call<{ event_id: string; job_id: string; cleanup_status: string }>(`${prefix}/delete`, input, {
      'Idempotency-Key': idempotency('delete', input.memory_id),
    }),
  move: (input: { memory_id: string; target_project_id: string; expected_revision: number }) =>
    call<{ memory: ProjectMemoryRecord; event_id: string; job_id: string; status: string }>(
      `${prefix}/scope/update`,
      input,
      { 'If-Match': `"${input.expected_revision}"` },
    ),
  policyGet: (input: { scope_type: 'global' | 'organization' | 'project'; scope_id: string }) =>
    call<Record<string, unknown>>(`${prefix}/policy/get`, input),
  policyUpdate: (input: {
    scope_type: 'global' | 'organization' | 'project';
    scope_id: string;
    patch: Record<string, unknown>;
    expected_revision: number;
  }) =>
    call<Record<string, unknown>>(`${prefix}/policy/update`, input, {
      'If-Match': `"${input.expected_revision}"`,
    }),
  jobs: () =>
    call<{ items: ProjectMemoryJob[]; next_cursor: string | null }>(`${prefix}/jobs/list`, {}),
  job: (jobId: string) => call<ProjectMemoryJob>(`${prefix}/jobs/get`, { job_id: jobId }),
  retryJob: (jobId: string, expectedRevision: number) =>
    call<ProjectMemoryJob>(
      `${prefix}/jobs/retry`,
      { job_id: jobId, expected_revision: expectedRevision },
      { 'Idempotency-Key': idempotency('retry', jobId) },
    ),
  audit: () =>
    call<{ items: ProjectMemoryAudit[]; next_cursor: string | null }>(`${prefix}/audit/list`, {}),
};
