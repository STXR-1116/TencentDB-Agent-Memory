/** Typed HTTP client for the project-memory service API. */

export interface ProjectMemoryClientOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface ProjectSummary {
  project_id: string;
  team_id: string;
  organization_id?: string;
  name: string;
  role: 'member' | 'manage' | 'admin';
  workspace_path?: string;
}

export interface MemoryRecord {
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
  importance?: number;
  recall_count?: number;
  last_recalled_at?: string | null;
  source_kind?: string;
}

export interface ProjectMemoryEnvelope<T> {
  code: string | number;
  message: string;
  request_id: string;
  data: T;
}

export interface RecallData {
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'PROJECT_REQUIRED';
  items: Array<{ memory_id: string; content: string; score: number; layer: 'L1' }>;
  context_text: string;
  effective_policy?: Record<string, unknown>;
}

export interface CaptureData {
  event_id: string;
  job_id: string;
  status: 'PENDING';
  accepted_count: number;
}

export class ProjectMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ProjectMemoryError';
  }
}

export class ProjectMemoryHttpClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ProjectMemoryClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async post<T>(path: string, input: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...headers },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const parsed = await response.json() as ProjectMemoryEnvelope<T>;
      if (!response.ok || parsed.code !== 0) {
        throw new ProjectMemoryError(response.status, parsed.code, parsed.message, parsed.request_id);
      }
      return parsed.data;
    } catch (cause) {
      if (cause instanceof ProjectMemoryError) throw cause;
      const message = cause instanceof Error && cause.name === 'AbortError' ? 'memory service unavailable' : cause instanceof Error ? cause.message : String(cause);
      throw new ProjectMemoryError(503, 'MEMORY_SERVICE_UNAVAILABLE', message);
    } finally {
      clearTimeout(timeout);
    }
  }

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.post('/v3/projects/list', {});
  }

  recall(input: { project_id: string; query: string; session_id?: string; task_id?: string }): Promise<RecallData> {
    return this.post('/v3/project-memory/recall', input);
  }

  capture(input: { project_id: string; session_id: string; task_id?: string; messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> }, idempotencyKey: string): Promise<CaptureData> {
    return this.post('/v3/project-memory/capture', input, { 'Idempotency-Key': idempotencyKey });
  }

  search(input: { project_id: string; query: string; cursor?: string | null; limit?: number; status?: string }): Promise<{ items: MemoryRecord[]; next_cursor: string | null; total_estimate: number }> {
    return this.post('/v3/project-memory/search', input);
  }

  list(input: { project_id: string; cursor?: string | null; limit?: number; keyword?: string; status?: string; captured_by_user_id?: string }): Promise<{ items: MemoryRecord[]; next_cursor: string | null; total_estimate: number }> {
    return this.post('/v3/project-memory/list', input);
  }

  get(memoryId: string): Promise<MemoryRecord & Record<string, unknown>> {
    return this.post('/v3/project-memory/get', { memory_id: memoryId });
  }

  update(input: { memory_id: string; content: string; expected_revision: number }): Promise<{ memory: MemoryRecord; event_id: string; job_id: string; status: string }> {
    return this.post('/v3/project-memory/update', input, { 'If-Match': `"${input.expected_revision}"` });
  }

  delete(input: { memory_id: string; expected_revision: number }, idempotencyKey: string): Promise<{ event_id: string; job_id: string; cleanup_status: string }> {
    return this.post('/v3/project-memory/delete', input, { 'Idempotency-Key': idempotencyKey });
  }

  scopeUpdate(input: { memory_id: string; target_project_id: string; expected_revision: number }): Promise<Record<string, unknown>> {
    return this.post('/v3/project-memory/scope/update', input, { 'If-Match': `"${input.expected_revision}"` });
  }

  policyGet(input: { scope_type: 'global' | 'organization' | 'project'; scope_id: string }): Promise<Record<string, unknown>> {
    return this.post('/v3/project-memory/policy/get', input);
  }

  policyUpdate(input: { scope_type: 'global' | 'organization' | 'project'; scope_id: string; patch: Record<string, unknown>; expected_revision: number }): Promise<Record<string, unknown>> {
    return this.post('/v3/project-memory/policy/update', input, { 'If-Match': `"${input.expected_revision}"` });
  }

  jobsGet(jobId: string): Promise<Record<string, unknown>> {
    return this.post('/v3/project-memory/jobs/get', { job_id: jobId });
  }

  jobsList(input: Record<string, unknown> = {}): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    return this.post('/v3/project-memory/jobs/list', input);
  }

  jobsRetry(input: { job_id: string; expected_revision: number }, idempotencyKey: string): Promise<Record<string, unknown>> {
    return this.post('/v3/project-memory/jobs/retry', input, { 'Idempotency-Key': idempotencyKey });
  }

  auditList(input: Record<string, unknown> = {}): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    return this.post('/v3/project-memory/audit/list', input);
  }
}

/** Resolve a server-authorized project from workspace metadata; never invents a project ID. */
export async function resolveProjectContext(
  client: ProjectMemoryHttpClient,
  workspacePath: string | undefined,
  configuredProjectId?: string,
): Promise<ProjectSummary> {
  const projects = (await client.listProjects()).projects;
  const normalizedPath = workspacePath?.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const candidates = configuredProjectId
    ? projects.filter((project) => project.project_id === configuredProjectId)
    : projects.filter((project) => {
      if (normalizedPath && project.workspace_path) return normalizedPath === project.workspace_path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
      return false;
    });
  if (candidates.length !== 1) throw new ProjectMemoryError(422, 'PROJECT_CONTEXT_REQUIRED', 'project context is required');
  return candidates[0];
}
