/**
 * Pi host adapter for project memory. Pi's provider hook remains responsible
 * for model routing; these helpers expose the same project-scoped lifecycle to
 * host integrations that have turn hooks available.
 */
import {
  ProjectMemoryHttpClient,
  type ProjectMemoryClientOptions,
} from '../../openclaw-plugin/src/project-memory-client.js';
import {
  captureProjectMemory,
  formatProjectMemoryContext,
  prepareProjectCaptureMessages,
  recallProjectMemory,
  resolveProject,
  type ProjectContext,
} from '../../openclaw-plugin/src/hooks/project-memory.js';

export interface PiProjectMemoryAdapter {
  resolve(workspacePath?: string): Promise<ProjectContext>;
  recall(query: string, sessionId?: string, taskId?: string): Promise<{ status: string; contextText?: string; promptBlock?: string }>;
  capture(sessionId: string, messages: unknown[], originalUserText?: string, taskId?: string, originalUserMessageCount?: number): Promise<{ accepted: boolean; jobId?: string; error?: string }>;
}

/** Create an explicit project-memory adapter for a Pi extension host. */
export function createPiProjectMemoryAdapter(options: ProjectMemoryClientOptions & { projectId?: string }): PiProjectMemoryAdapter {
  const client = new ProjectMemoryHttpClient(options);
  let context: ProjectContext | undefined;
  return {
    async resolve(workspacePath) {
      context = await resolveProject(client, workspacePath, options.projectId);
      return context;
    },
    async recall(query, sessionId, taskId) {
      const result = await recallProjectMemory(client, context, query, sessionId, taskId);
      return { status: result.status, contextText: result.contextText, promptBlock: formatProjectMemoryContext(result.contextText) };
    },
    capture(sessionId, messages, originalUserText, taskId, originalUserMessageCount) {
      const cleaned = prepareProjectCaptureMessages(messages, originalUserText, originalUserMessageCount);
      if (cleaned.length === 0) return Promise.resolve({ accepted: false, error: 'NO_TURN_BOUNDARY' });
      const lastTimestamp = cleaned[cleaned.length - 1]?.timestamp ?? 'none';
      const idempotencyKey = `pi-capture-${sessionId}-${cleaned.length}-${lastTimestamp}`;
      return captureProjectMemory(client, context, { session_id: sessionId, task_id: taskId, messages: cleaned }, idempotencyKey);
    },
  };
}
