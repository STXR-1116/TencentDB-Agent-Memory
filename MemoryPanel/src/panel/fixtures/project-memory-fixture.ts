/**
 * Deterministic project-memory integration fixture.
 *
 * This module is test/integration-only. It intentionally has no persistence,
 * model, vector store, or production authentication implementation.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';

type Role = 'member' | 'manage' | 'admin';
type MemoryStatus = 'ACTIVE' | 'DELETED';
type JobStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

interface Identity {
  userId: string;
  role: Role;
  organizationIds: string[];
  projectIds: string[];
}

interface Project {
  project_id: string;
  team_id: string;
  organization_id: string;
  name: string;
  role: Role;
  workspace_path?: string;
}

interface MemoryRecord {
  memory_id: string;
  team_id: string;
  project_id: string;
  content: string;
  layer: 'L1';
  captured_by_user_id: string;
  created_at: string;
  updated_at: string;
  revision: number;
  status: MemoryStatus;
  importance: number;
  recall_count: number;
  last_recalled_at: string | null;
  source_kind: string;
}

interface Job {
  job_id: string;
  event_id: string;
  kind: string;
  team_id: string;
  project_id: string;
  requested_by_user_id: string;
  status: JobStatus;
  retry_count: number;
  retryable: boolean;
  created_at: string;
  finished_at: string | null;
  error_code: string | null;
}

interface FixtureState {
  readonly projects: Project[];
  readonly identities: Map<string, Identity>;
  readonly memories: Map<string, MemoryRecord>;
  readonly jobs: Map<string, Job>;
  readonly audits: Array<Record<string, unknown>>;
  readonly idempotency: Map<string, { fingerprint: string; response: Response }>;
  readonly policies: Map<string, { revision: number; values: Record<string, unknown> }>;
  nextCapture: number;
}

const NOW = '2026-09-02T00:00:00.000Z';
const PROJECTS: Project[] = [
  { project_id: 'project-alpha', team_id: 'team-core', organization_id: 'org-core', name: 'Alpha', role: 'member', workspace_path: 'g:/tencentdb-agent-memory' },
  { project_id: 'project-beta', team_id: 'team-platform', organization_id: 'org-platform', name: 'Beta', role: 'manage', workspace_path: 'g:/tencentdb-agent-memory/beta' },
];

function seedState(): FixtureState {
  const identities = new Map<string, Identity>([
    ['fixture-member-alice', { userId: 'user-alice', role: 'member', organizationIds: ['org-core'], projectIds: ['project-alpha'] }],
    ['fixture-member-bob', { userId: 'user-bob', role: 'member', organizationIds: ['org-core'], projectIds: ['project-alpha'] }],
    ['fixture-manage', { userId: 'user-manage', role: 'manage', organizationIds: ['org-core'], projectIds: ['project-alpha'] }],
    ['fixture-admin', { userId: 'user-admin', role: 'admin', organizationIds: ['org-core', 'org-platform'], projectIds: ['project-alpha', 'project-beta'] }],
  ]);
  const memories = new Map<string, MemoryRecord>([
    ['memory-alpha-alice', { memory_id: 'memory-alpha-alice', team_id: 'team-core', project_id: 'project-alpha', content: 'Alpha uses strict TypeScript checks.', layer: 'L1', captured_by_user_id: 'user-alice', created_at: NOW, updated_at: NOW, revision: 1, status: 'ACTIVE', importance: 0.8, recall_count: 0, last_recalled_at: null, source_kind: 'agent_turn' }],
    ['memory-alpha-bob', { memory_id: 'memory-alpha-bob', team_id: 'team-core', project_id: 'project-alpha', content: 'Alpha deploys through the release pipeline.', layer: 'L1', captured_by_user_id: 'user-bob', created_at: NOW, updated_at: NOW, revision: 1, status: 'ACTIVE', importance: 0.7, recall_count: 0, last_recalled_at: null, source_kind: 'agent_turn' }],
    ['memory-beta-manage', { memory_id: 'memory-beta-manage', team_id: 'team-platform', project_id: 'project-beta', content: 'Beta owns platform reliability.', layer: 'L1', captured_by_user_id: 'user-manage', created_at: NOW, updated_at: NOW, revision: 1, status: 'ACTIVE', importance: 0.9, recall_count: 0, last_recalled_at: null, source_kind: 'agent_turn' }],
  ]);
  return { projects: PROJECTS.map((project) => ({ ...project })), identities, memories, jobs: new Map(), audits: [], idempotency: new Map(), policies: new Map(), nextCapture: 1 };
}

function envelope<T>(code: string | number, message: string, data: T): Response {
  const requestHash = createHash('sha256').update(JSON.stringify({ code, message, data })).digest('hex').slice(0, 16);
  return Response.json({ code, message, request_id: `req_fixture_${requestHash}`, data });
}

function error(code: string, status: number, message = code): Response {
  const response = envelope(code, message, null);
  return new Response(response.body, { status, headers: response.headers });
}

function identity(c: { req: { header(name: string): string | undefined } }, state: FixtureState): Identity | null {
  const panelKey = c.req.header('x-tdai-user-key');
  const authorization = c.req.header('authorization');
  const bearerKey = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return state.identities.get(panelKey ?? bearerKey ?? '') ?? null;
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const value = await c.req.json();
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function projectFor(state: FixtureState, projectId: unknown, actor: Identity): Project | null {
  if (typeof projectId !== 'string' || !projectId) return null;
  const project = state.projects.find((candidate) => candidate.project_id === projectId);
  return project && (actor.role === 'admin' || actor.projectIds.includes(project.project_id)) ? project : null;
}

function projectsForFilter(state: FixtureState, input: Record<string, unknown>, actor: Identity): Project[] {
  const requestedProject = typeof input.project_id === 'string' && input.project_id ? input.project_id : undefined;
  const requestedTeam = typeof input.team_id === 'string' && input.team_id ? input.team_id : undefined;
  const requestedOrganization = typeof input.organization_id === 'string' && input.organization_id ? input.organization_id : undefined;
  return state.projects.filter((project) => {
    if (actor.role !== 'admin' && !actor.projectIds.includes(project.project_id)) return false;
    if (requestedProject && project.project_id !== requestedProject) return false;
    if (requestedTeam && project.team_id !== requestedTeam) return false;
    if (requestedOrganization && project.organization_id !== requestedOrganization) return false;
    return true;
  });
}

function projectRequired(projectId: unknown): Response | null {
  return typeof projectId === 'string' && projectId.trim() ? null : error('PROJECT_CONTEXT_REQUIRED', 422, 'project context is required');
}

function visibleMemory(state: FixtureState, actor: Identity, memory: MemoryRecord): boolean {
  return memory.status === 'ACTIVE' && (actor.role === 'admin' || actor.projectIds.includes(memory.project_id));
}

function sanitizeCapture(content: string): string {
  return content
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, '')
    .replace(/<user-persona>[\s\S]*?<\/user-persona>/g, '')
    .replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cursorFor(filter: Record<string, unknown>, offset: number): string {
  return Buffer.from(JSON.stringify({ filter, offset }), 'utf8').toString('base64url');
}

function readCursor(cursor: unknown, filter: Record<string, unknown>): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  if (typeof cursor !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { filter?: Record<string, unknown>; offset?: number };
    return JSON.stringify(parsed.filter) === JSON.stringify(filter) && Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : null;
  } catch {
    return null;
  }
}

function recordView(record: MemoryRecord): MemoryRecord {
  return { ...record };
}

function addAudit(state: FixtureState, actor: Identity, operation: string, memory: MemoryRecord | undefined, extra: Record<string, unknown> = {}): void {
  state.audits.push({ audit_id: `audit_${state.audits.length + 1}`, operation, operated_by_user_id: actor.userId, role: actor.role, memory_id: memory?.memory_id ?? null, project_id: memory?.project_id ?? null, old_revision: memory?.revision ?? null, result: 'SUCCEEDED', request_id: `req_fixture_${state.audits.length + 1}`, event_id: extra.event_id ?? null, ...extra });
}

function newJob(state: FixtureState, kind: string, projectId: string, teamId: string, requestedByUserId: string, failed = false): Job {
  const job: Job = { job_id: `job_${state.jobs.size + 1}`, event_id: `evt_${state.jobs.size + 1}`, kind, team_id: teamId, project_id: projectId, requested_by_user_id: requestedByUserId, status: failed ? 'FAILED' : 'PENDING', retry_count: 0, retryable: failed, created_at: NOW, finished_at: failed ? NOW : null, error_code: failed ? 'MEMORY_SERVICE_UNAVAILABLE' : null };
  state.jobs.set(job.job_id, job);
  return job;
}

export function buildProjectMemoryFixtureApp(): Hono {
  const state = seedState();
  const app = new Hono();
  app.post('/v3/projects/list', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    return envelope(0, 'ok', { projects: state.projects.filter((project) => actor.role === 'admin' || actor.projectIds.includes(project.project_id)).map((project) => ({ ...project, role: actor.role })) });
  });

  app.post('/v3/project-memory/recall', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    const missing = projectRequired(input.project_id);
    if (missing) return missing;
    if (c.req.header('x-fixture-scenario') === 'unavailable') return error('MEMORY_SERVICE_UNAVAILABLE', 503, 'memory service unavailable');
    const project = projectFor(state, input.project_id, actor);
    if (!project) return error('PROJECT_ACCESS_DENIED', 403);
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
    const items = [...state.memories.values()].filter((memory) => visibleMemory(state, actor, memory) && memory.project_id === project.project_id && (!query || memory.content.toLowerCase().includes(query))).map((memory) => ({ memory_id: memory.memory_id, content: memory.content, score: 0.9, layer: memory.layer }));
    return envelope(0, 'ok', { status: 'READY', items, context_text: items.map((item) => item.content).join('\n'), strategy: 'hybrid', effective_policy: { top_k: 8, relevance_threshold: 0.4, token_budget: 1200 } });
  });

  app.post('/v3/project-memory/capture', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    const missing = projectRequired(input.project_id);
    if (missing) return missing;
    const project = projectFor(state, input.project_id, actor);
    if (!project) return error('PROJECT_ACCESS_DENIED', 403);
    const key = c.req.header('idempotency-key');
    if (!key) return error('INVALID_REQUEST', 400, 'Idempotency-Key is required');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = state.idempotency.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.response.clone() : error('IDEMPOTENCY_CONFLICT', 409);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    let accepted = 0;
    for (const raw of messages) {
      if (!raw || typeof raw !== 'object') continue;
      const message = raw as Record<string, unknown>;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const content = typeof message.content === 'string' ? sanitizeCapture(message.content) : '';
      if (!content || content.startsWith('/')) continue;
      const id = `memory-${project.project_id}-capture-${state.nextCapture++}`;
      state.memories.set(id, { memory_id: id, team_id: project.team_id, project_id: project.project_id, content, layer: 'L1', captured_by_user_id: actor.userId, created_at: NOW, updated_at: NOW, revision: 1, status: 'ACTIVE', importance: 0.5, recall_count: 0, last_recalled_at: null, source_kind: 'agent_turn' });
      accepted += 1;
    }
    const job = newJob(state, 'CAPTURE', project.project_id, project.team_id, actor.userId);
    const response = envelope(0, 'accepted', { event_id: job.event_id, job_id: job.job_id, status: 'PENDING', accepted_count: accepted });
    const acceptedResponse = new Response(response.body, { status: 202, headers: response.headers });
    state.idempotency.set(key, { fingerprint, response: acceptedResponse.clone() });
    addAudit(state, actor, 'CAPTURE_ACCEPTED', undefined, { event_id: job.event_id, project_id: project.project_id });
    return acceptedResponse;
  });

  const listHandler = async (c: Context): Promise<Response> => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    if (actor.role === 'member' && (typeof input.project_id !== 'string' || !input.project_id.trim())) return error('PROJECT_CONTEXT_REQUIRED', 422);
    const projects = projectsForFilter(state, input, actor);
    if (projects.length === 0) return input.project_id || input.team_id || input.organization_id ? error('PROJECT_ACCESS_DENIED', 403) : error('PROJECT_CONTEXT_REQUIRED', 422);
    if (actor.role === 'member' && projects.length !== 1) return error('PROJECT_CONTEXT_REQUIRED', 422);
    const filter = { project_id: typeof input.project_id === 'string' ? input.project_id : null, team_id: typeof input.team_id === 'string' ? input.team_id : null, organization_id: typeof input.organization_id === 'string' ? input.organization_id : null, keyword: typeof input.keyword === 'string' ? input.keyword : (typeof input.query === 'string' ? input.query : ''), status: typeof input.status === 'string' ? input.status : 'ACTIVE', captured_by_user_id: actor.role === 'member' ? null : (typeof input.captured_by_user_id === 'string' ? input.captured_by_user_id : null) };
    const offset = readCursor(input.cursor, filter);
    if (offset === null) return error('INVALID_CURSOR', 400);
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
    const keyword = filter.keyword.toLowerCase();
    const projectIds = new Set(projects.map((project) => project.project_id));
    const records = [...state.memories.values()].filter((memory) => visibleMemory(state, actor, memory) && projectIds.has(memory.project_id) && (filter.status === 'ACTIVE' ? memory.status === 'ACTIVE' : memory.status === filter.status) && (!keyword || memory.content.toLowerCase().includes(keyword)) && (!filter.captured_by_user_id || memory.captured_by_user_id === filter.captured_by_user_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.memory_id.localeCompare(a.memory_id));
    const page = records.slice(offset, offset + limit).map(recordView);
    return envelope(0, 'ok', { items: page, next_cursor: offset + limit < records.length ? cursorFor(filter, offset + limit) : null, total_estimate: records.length });
  };
  app.post('/v3/project-memory/list', listHandler);
  app.post('/v3/project-memory/search', listHandler);

  app.post('/v3/project-memory/get', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('MEMORY_NOT_FOUND', 404);
    const input = await body(c);
    const memory = typeof input.memory_id === 'string' ? state.memories.get(input.memory_id) : undefined;
    if (!memory || !visibleMemory(state, actor, memory)) return error('MEMORY_NOT_FOUND', 404);
    return envelope(0, 'ok', { ...recordView(memory), layers: { L2: null, L3: null }, source_summary: { kind: memory.source_kind } });
  });

  app.post('/v3/project-memory/update', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('MEMORY_EDIT_FORBIDDEN', 403);
    const input = await body(c);
    const memory = typeof input.memory_id === 'string' ? state.memories.get(input.memory_id) : undefined;
    if (!memory || !visibleMemory(state, actor, memory)) return error('MEMORY_NOT_FOUND', 404);
    if (actor.role === 'member' && memory.captured_by_user_id !== actor.userId) return error('MEMORY_EDIT_FORBIDDEN', 403);
    const expected = Number(input.expected_revision);
    const match = c.req.header('if-match')?.replaceAll('"', '');
    if ((match && Number(match) !== expected) || expected !== memory.revision) return error('MEMORY_REVISION_CONFLICT', 409);
    if (typeof input.content !== 'string' || !input.content.trim()) return error('INVALID_REQUEST', 400);
    memory.content = input.content.trim();
    memory.revision += 1;
    memory.updated_at = NOW;
    const job = newJob(state, 'INDEX_REFRESH', memory.project_id, memory.team_id, actor.userId);
    addAudit(state, actor, 'MEMORY_UPDATED', memory, { event_id: job.event_id });
    return envelope(0, 'ok', { memory: recordView(memory), event_id: job.event_id, job_id: job.job_id, status: 'INDEX_PENDING' });
  });

  app.post('/v3/project-memory/delete', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('MEMORY_DELETE_FORBIDDEN', 403);
    const input = await body(c);
    const memory = typeof input.memory_id === 'string' ? state.memories.get(input.memory_id) : undefined;
    const key = c.req.header('idempotency-key');
    if (!key) return error('INVALID_REQUEST', 400, 'Idempotency-Key is required');
    const fingerprint = JSON.stringify(input);
    const previous = state.idempotency.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.response.clone() : error('IDEMPOTENCY_CONFLICT', 409);
    if (!memory || !visibleMemory(state, actor, memory)) return error('MEMORY_NOT_FOUND', 404);
    if (actor.role === 'member' && memory.captured_by_user_id !== actor.userId) return error('MEMORY_DELETE_FORBIDDEN', 403);
    if (Number(input.expected_revision) !== memory.revision) return error('MEMORY_REVISION_CONFLICT', 409);
    memory.status = 'DELETED';
    const failed = c.req.header('x-fixture-scenario') === 'cleanup-failed';
    const job = newJob(state, 'DELETE_CLEANUP', memory.project_id, memory.team_id, actor.userId, failed);
    addAudit(state, actor, 'MEMORY_DELETED', memory, { event_id: job.event_id });
    const response = envelope(0, 'accepted', { event_id: job.event_id, job_id: job.job_id, cleanup_status: failed ? 'FAILED' : 'PENDING' });
    const acceptedResponse = new Response(response.body, { status: 202, headers: response.headers });
    state.idempotency.set(key, { fingerprint, response: acceptedResponse.clone() });
    return acceptedResponse;
  });

  app.post('/v3/project-memory/scope/update', async (c) => {
    const actor = identity(c, state);
    if (!actor || actor.role === 'member') return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    const memory = typeof input.memory_id === 'string' ? state.memories.get(input.memory_id) : undefined;
    const target = projectFor(state, input.target_project_id, actor);
    if (!memory || !visibleMemory(state, actor, memory) || !target) return error('MEMORY_NOT_FOUND', 404);
    if (Number(input.expected_revision) !== memory.revision) return error('MEMORY_REVISION_CONFLICT', 409);
    const oldProject = memory.project_id;
    memory.project_id = target.project_id;
    memory.team_id = target.team_id;
    memory.updated_at = NOW;
    const job = newJob(state, 'SCOPE_MOVED', target.project_id, target.team_id, actor.userId);
    addAudit(state, actor, 'SCOPE_MOVED', memory, { old_project_id: oldProject, new_project_id: target.project_id, event_id: job.event_id });
    return envelope(0, 'ok', { memory: recordView(memory), event_id: job.event_id, job_id: job.job_id, status: 'INDEX_PENDING' });
  });

  app.post('/v3/project-memory/policy/get', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    if (!policyScopeAllowed(state, input, actor)) return error('PROJECT_ACCESS_DENIED', 403);
    const key = `${String(input.scope_type ?? 'project')}:${String(input.scope_id ?? '')}`;
    const current = state.policies.get(key) ?? { revision: 1, values: { recall_scope: 'project', top_k: 8, relevance_threshold: 0.4, token_budget: 1200, l0_retention_days: 30, auto_capture: true } };
    return envelope(0, 'ok', { ...current.values, revision: current.revision, fields: Object.fromEntries(Object.entries(current.values).map(([name, value]) => [name, { value, source_scope: input.scope_type ?? 'project', revision: current.revision, hard_limit: value }] )) });
  });

  app.post('/v3/project-memory/policy/update', async (c) => {
    const actor = identity(c, state);
    if (!actor || actor.role === 'member') return error('PROJECT_ACCESS_DENIED', 403);
    const input = await body(c);
    if (!policyScopeAllowed(state, input, actor)) return error('PROJECT_ACCESS_DENIED', 403);
    const key = `${String(input.scope_type ?? 'project')}:${String(input.scope_id ?? '')}`;
    const current = state.policies.get(key) ?? { revision: 1, values: { recall_scope: 'project', top_k: 8, relevance_threshold: 0.4, token_budget: 1200, l0_retention_days: 30, auto_capture: true } };
    if (Number(input.expected_revision) !== current.revision) return error('MEMORY_REVISION_CONFLICT', 409);
    const patch = input.patch && typeof input.patch === 'object' ? input.patch as Record<string, unknown> : {};
    const defaults = { top_k: 8, relevance_threshold: 0.4, token_budget: 1200, l0_retention_days: 30 };
    const global = state.policies.get('global:global')?.values ?? defaults;
    if (
      patch.auto_capture === false ||
      patch.recall_scope === 'global' ||
      (typeof patch.top_k === 'number' && patch.top_k > Number(global.top_k ?? defaults.top_k)) ||
      (typeof patch.token_budget === 'number' && patch.token_budget > Number(global.token_budget ?? defaults.token_budget)) ||
      (typeof patch.relevance_threshold === 'number' && patch.relevance_threshold < Number(global.relevance_threshold ?? defaults.relevance_threshold)) ||
      (typeof patch.l0_retention_days === 'number' && patch.l0_retention_days > Number(global.l0_retention_days ?? defaults.l0_retention_days))
    ) return error('POLICY_LIMIT_EXCEEDED', 422);
    current.values = { ...current.values, ...patch };
    current.revision += 1;
    state.policies.set(key, current);
    const job = newJob(state, 'POLICY_UPDATED', String(input.scope_id ?? ''), 'team-core', actor.userId);
    addAudit(state, actor, 'POLICY_UPDATED', undefined, { event_id: job.event_id });
    return envelope(0, 'ok', {
      ...current.values,
      revision: current.revision,
      fields: Object.fromEntries(Object.entries(current.values).map(([name, value]) => [name, { value, source_scope: input.scope_type ?? 'project', revision: current.revision, hard_limit: value }])),
      job_id: job.job_id,
    });
  });

  app.post('/v3/project-memory/jobs/get', async (c) => {
    const actor = identity(c, state);
    const input = await body(c);
    const job = typeof input.job_id === 'string' ? state.jobs.get(input.job_id) : undefined;
    if (!actor || !job || (actor.role === 'member' && (job.requested_by_user_id !== actor.userId || !actor.projectIds.includes(job.project_id)))) return error('JOB_NOT_FOUND', 404);
    return envelope(0, 'ok', job);
  });
  app.post('/v3/project-memory/jobs/list', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    return envelope(0, 'ok', { items: [...state.jobs.values()].filter((job) => actor.role !== 'member' ? actor.role === 'admin' || actor.projectIds.includes(job.project_id) : actor.projectIds.includes(job.project_id) && job.requested_by_user_id === actor.userId), next_cursor: null });
  });
  app.post('/v3/project-memory/jobs/retry', async (c) => {
    const actor = identity(c, state);
    const input = await body(c);
    const job = typeof input.job_id === 'string' ? state.jobs.get(input.job_id) : undefined;
    const key = c.req.header('idempotency-key');
    if (!key) return error('INVALID_REQUEST', 400, 'Idempotency-Key is required');
    const fingerprint = JSON.stringify(input);
    const previous = state.idempotency.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.response.clone() : error('IDEMPOTENCY_CONFLICT', 409);
    if (!actor || !job || actor.role === 'member' || !job.retryable || Number(input.expected_revision) !== job.retry_count) return error('JOB_NOT_RETRYABLE', 409);
    job.status = 'PENDING';
    job.retryable = false;
    job.retry_count += 1;
    addAudit(state, actor, 'JOB_RETRIED', undefined, { event_id: job.event_id });
    const response = envelope(0, 'accepted', job);
    const acceptedResponse = new Response(response.body, { status: 202, headers: response.headers });
    state.idempotency.set(key, { fingerprint, response: acceptedResponse.clone() });
    return acceptedResponse;
  });
  app.post('/v3/project-memory/audit/list', async (c) => {
    const actor = identity(c, state);
    if (!actor) return error('PROJECT_ACCESS_DENIED', 403);
    return envelope(0, 'ok', { items: state.audits.filter((audit) => actor.role === 'admin' || actor.projectIds.includes(String(audit.project_id ?? ''))), next_cursor: null });
  });
  return app;
}

function policyScopeAllowed(state: FixtureState, input: Record<string, unknown>, actor: Identity): boolean {
  const scopeType = input.scope_type;
  const scopeId = input.scope_id;
  if (scopeType === 'global') return actor.role === 'admin' && scopeId === 'global';
  if (scopeType === 'organization') return typeof scopeId === 'string' && (actor.role === 'admin' || actor.organizationIds.includes(scopeId));
  if (scopeType === 'project') return !!projectFor(state, scopeId, actor);
  return false;
}
