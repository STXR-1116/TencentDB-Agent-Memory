import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  projectMemoryApi,
  type ProjectMemoryAudit,
  type ProjectMemoryJob,
  type ProjectMemoryRecord,
  type ProjectSummary,
} from '@/lib/api/project-memory';
import {
  canGovernProjectMemory,
  isCurrentProjectMemoryRequest,
  projectMemoryErrorText,
  resetProjectMemoryPagination,
} from '@/lib/project-memory-contract';
import './style.css';

type View = 'memory' | 'policy' | 'health' | 'audit';

export function ProjectMemoryPage() {
  const [view, setView] = useState<View>('memory');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [records, setRecords] = useState<ProjectMemoryRecord[]>([]);
  const [selected, setSelected] = useState<ProjectMemoryRecord | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [jobs, setJobs] = useState<ProjectMemoryJob[]>([]);
  const [audits, setAudits] = useState<ProjectMemoryAudit[]>([]);
  const [policy, setPolicy] = useState<Record<string, unknown> | null>(null);
  const [policyRevision, setPolicyRevision] = useState<number | null>(null);
  const [policyTopK, setPolicyTopK] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState('');
  const listRequestGeneration = useRef(0);

  useEffect(() => {
    void projectMemoryApi
      .projects()
      .then((result) => {
        setProjects(result.projects);
      })
      .catch((cause) => setError(projectMemoryErrorText(cause)));
  }, []);

  const loadList = useCallback(
    async (next: string | null = null, query = keyword) => {
      const responseGeneration = ++listRequestGeneration.current;
      if (!projectId) {
        setRecords([]);
        setError('PROJECT_CONTEXT_REQUIRED');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const result = await projectMemoryApi.list({
          ...(projectId === '*'
            ? { organization_id: organizationId || undefined, team_id: teamId || undefined }
            : { project_id: projectId }),
          cursor: next,
          limit: 20,
          keyword: query || undefined,
        });
        if (!isCurrentProjectMemoryRequest(listRequestGeneration.current, responseGeneration))
          return;
        setRecords(result.items);
        setNextCursor(result.next_cursor);
        setCursor(next);
        setSelected((current) =>
          current && result.items.some((item) => item.memory_id === current.memory_id)
            ? current
            : (result.items[0] ?? null),
        );
      } catch (cause) {
        if (isCurrentProjectMemoryRequest(listRequestGeneration.current, responseGeneration))
          setError(projectMemoryErrorText(cause));
      } finally {
        if (isCurrentProjectMemoryRequest(listRequestGeneration.current, responseGeneration))
          setLoading(false);
      }
    },
    [keyword, organizationId, projectId, teamId],
  );

  useEffect(() => {
    if (view === 'memory' && projectId) void loadList(null);
  }, [loadList, projectId, view]);

  const loadView = useCallback(
    async (nextView: View) => {
      setView(nextView);
      setError('');
      try {
        if (nextView === 'policy' && projectId && projectId !== '*') {
          const loaded = await projectMemoryApi.policyGet({
            scope_type: 'project',
            scope_id: projectId,
          });
          setPolicy(loaded);
          const revision = typeof loaded.revision === 'number' ? loaded.revision : null;
          setPolicyRevision(revision);
          setPolicyTopK(
            String(
              loaded.top_k ?? (loaded.values as Record<string, unknown> | undefined)?.top_k ?? '',
            ),
          );
        }
        if (nextView === 'health') setJobs((await projectMemoryApi.jobs()).items);
        if (nextView === 'audit') setAudits((await projectMemoryApi.audit()).items);
      } catch (cause) {
        setError(projectMemoryErrorText(cause));
      }
    },
    [projectId],
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.project_id === projectId),
    [projectId, projects],
  );
  const projectName = projectId === '*' ? '全部可见项目' : (selectedProject?.name ?? '未选择项目');
  const canManage =
    projectId === '*'
      ? projects.some((project) => canGovernProjectMemory(project.role))
      : canGovernProjectMemory(selectedProject?.role);
  const organizations = useMemo(
    () => [
      ...new Set(
        projects.map((project) => project.organization_id).filter((id): id is string => !!id),
      ),
    ],
    [projects],
  );
  const teams = useMemo(() => [...new Set(projects.map((project) => project.team_id))], [projects]);

  function resetPagination() {
    const page = resetProjectMemoryPagination();
    setCursor(page.cursor);
    setNextCursor(page.nextCursor);
  }

  function invalidateListRequests() {
    listRequestGeneration.current += 1;
    setRecords([]);
    setSelected(null);
    setLoading(false);
  }

  async function saveRecord() {
    if (!selected) return;
    try {
      const result = await projectMemoryApi.update({
        memory_id: selected.memory_id,
        content: draft,
        expected_revision: selected.revision,
      });
      setSelected(result.memory);
      setRecords((items) =>
        items.map((item) => (item.memory_id === result.memory.memory_id ? result.memory : item)),
      );
      setStatus(`INDEX_PENDING · ${result.job_id}`);
      setDraft(result.memory.content);
    } catch (cause) {
      setError(projectMemoryErrorText(cause));
    }
  }

  async function deleteRecord() {
    if (
      !selected ||
      !window.confirm(
        `删除“${selected.content.slice(0, 80)}”后将影响当前项目所有成员的召回。确认删除？`,
      )
    )
      return;
    try {
      const result = await projectMemoryApi.delete({
        memory_id: selected.memory_id,
        expected_revision: selected.revision,
      });
      setRecords((items) => items.filter((item) => item.memory_id !== selected.memory_id));
      setSelected(null);
      setStatus(`已停止召回，清理任务 ${result.job_id}`);
    } catch (cause) {
      setError(projectMemoryErrorText(cause));
    }
  }

  async function moveRecord() {
    if (!selected || !canManage || !targetProjectId || targetProjectId === selected.project_id)
      return;
    if (
      !window.confirm(
        `将记忆调整到“${projects.find((project) => project.project_id === targetProjectId)?.name ?? targetProjectId}”后，原项目将立即停止召回。确认调整？`,
      )
    )
      return;
    try {
      const result = await projectMemoryApi.move({
        memory_id: selected.memory_id,
        target_project_id: targetProjectId,
        expected_revision: selected.revision,
      });
      setRecords((items) => items.filter((item) => item.memory_id !== selected.memory_id));
      setSelected(null);
      setStatus(`项目调整已接受，索引任务 ${result.job_id}`);
    } catch (cause) {
      setError(projectMemoryErrorText(cause));
    }
  }

  async function savePolicy() {
    if (!canManage || !projectId || policyRevision === null) return;
    const topK = Number(policyTopK);
    if (!Number.isInteger(topK) || topK < 1) return;
    try {
      const result = await projectMemoryApi.policyUpdate({
        scope_type: 'project',
        scope_id: projectId,
        patch: { top_k: topK },
        expected_revision: policyRevision,
      });
      setPolicy(result);
      setPolicyRevision(typeof result.revision === 'number' ? result.revision : policyRevision + 1);
      setStatus('策略更新已接受');
    } catch (cause) {
      setError(projectMemoryErrorText(cause));
    }
  }

  return (
    <section className="project-memory-page">
      <header className="project-memory-header">
        <div>
          <p className="eyebrow">TEAM MEMORY</p>
          <h1>团队记忆</h1>
          <p className="subtle">服务端事实源 · {projectName}</p>
        </div>
        <div className="project-memory-filters">
          <label>
            项目
            <select
              value={projectId}
              onChange={(event) => {
                invalidateListRequests();
                setProjectId(event.target.value);
                resetPagination();
              }}
            >
              <option value="">未识别项目</option>
              {canManage && <option value="*">全部可见项目</option>}
              {projects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {canManage && (
            <label>
              组织
              <select
                value={organizationId}
                onChange={(event) => {
                  invalidateListRequests();
                  setOrganizationId(event.target.value);
                  resetPagination();
                }}
              >
                <option value="">全部组织</option>
                {organizations.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canManage && (
            <label>
              团队
              <select
                value={teamId}
                onChange={(event) => {
                  invalidateListRequests();
                  setTeamId(event.target.value);
                  resetPagination();
                }}
              >
                <option value="">全部团队</option>
                {teams.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>
      <nav className="project-memory-tabs" aria-label="记忆治理视图">
        {(
          [
            ['memory', '团队记忆'],
            ['policy', '记忆策略'],
            ['health', '运行健康'],
            ['audit', '记忆审计'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={view === key ? 'active' : ''}
            onClick={() => void loadView(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div className="project-memory-error" role="alert">
          {error}
        </div>
      )}
      {status && <div className="project-memory-status">{status}</div>}
      {!projectId && (
        <div className="project-memory-context-required" role="status">
          未识别项目，无法加载记忆
        </div>
      )}
      {view === 'memory' && projectId && (
        <div className="project-memory-workspace">
          <div className="project-memory-list">
            <div className="toolbar">
              <input
                value={keyword}
                placeholder="搜索 L1 正文"
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadList(null, keyword);
                }}
              />
              <button onClick={() => void loadList(null, keyword)}>搜索</button>
              <span>{loading ? '加载中…' : `${records.length} 条`}</span>
            </div>
            {records.map((record) => (
              <button
                className={`memory-row ${selected?.memory_id === record.memory_id ? 'selected' : ''}`}
                key={record.memory_id}
                onClick={() => {
                  setSelected(record);
                  setDraft(record.content);
                  setTargetProjectId(record.project_id);
                }}
              >
                <strong>{record.content}</strong>
                <small>
                  {record.memory_id} · revision {record.revision} · {record.captured_by_user_id}
                </small>
              </button>
            ))}
            {records.length === 0 && !loading && <div className="empty">当前筛选条件没有记忆</div>}
            <div className="pager">
              <button disabled={!cursor} onClick={() => void loadList(null)}>
                第一页
              </button>
              <button disabled={!nextCursor} onClick={() => void loadList(nextCursor)}>
                下一页
              </button>
            </div>
          </div>
          <aside className="project-memory-detail">
            {selected ? (
              <>
                <div className="detail-title">
                  <span>L1 · revision {selected.revision}</span>
                  <span>{selected.status}</span>
                </div>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  readOnly={!canManage}
                />
                <div className="detail-meta">
                  <span>
                    项目{' '}
                    {projects.find((project) => project.project_id === selected.project_id)?.name ??
                      selected.project_id}
                  </span>
                  <span>捕获人 {selected.captured_by_user_id}</span>
                  <span>召回 {selected.recall_count} 次</span>
                  <span>更新时间 {new Date(selected.updated_at).toLocaleString()}</span>
                </div>
                {canManage && (
                  <div className="detail-actions">
                    <button onClick={() => void saveRecord()} disabled={!draft.trim()}>
                      保存正文
                    </button>
                    <button className="danger" onClick={() => void deleteRecord()}>
                      删除
                    </button>
                    <select
                      value={targetProjectId}
                      onChange={(event) => setTargetProjectId(event.target.value)}
                      aria-label="目标项目"
                    >
                      {projects.map((project) => (
                        <option key={project.project_id} value={project.project_id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void moveRecord()}
                      disabled={!targetProjectId || targetProjectId === selected.project_id}
                    >
                      调整项目
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty">选择一条记忆查看详情</div>
            )}
          </aside>
        </div>
      )}
      {view === 'policy' && projectId && (
        <div className="governance-panel">
          <h2>生效策略</h2>
          {policy ? (
            <>
              <dl>
                {Object.entries(policy)
                  .filter(([key]) => key !== 'fields' && key !== 'values')
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
              </dl>
              {typeof policy.fields === 'object' && policy.fields !== null && (
                <dl>
                  {Object.entries(
                    policy.fields as Record<
                      string,
                      { value?: unknown; source_scope?: unknown; hard_limit?: unknown }
                    >,
                  ).map(([key, field]) => (
                    <div key={key}>
                      <dt>
                        {key} 来源 {String(field.source_scope ?? 'server')}
                      </dt>
                      <dd>
                        {String(field.value)} · 上限 {String(field.hard_limit ?? 'server')}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {canManage && (
                <div className="policy-edit">
                  <label>
                    top_k{' '}
                    <input
                      value={policyTopK}
                      inputMode="numeric"
                      onChange={(event) => setPolicyTopK(event.target.value)}
                    />
                  </label>
                  <button onClick={() => void savePolicy()}>保存策略</button>
                </div>
              )}
              <p className="subtle">
                auto_capture 固定为 true，项目只能收紧全局限制。revision{' '}
                {String(policyRevision ?? policy.revision ?? '-')}
              </p>
            </>
          ) : (
            <p className="empty">选择项目后加载策略</p>
          )}
        </div>
      )}
      {view === 'health' && (
        <div className="governance-panel">
          <h2>任务</h2>
          {jobs.map((job) => (
            <div className="job-row" key={job.job_id}>
              <strong>{job.kind}</strong>
              <span>{job.job_id}</span>
              <span>{job.status}</span>
              {job.error_code && <code>{job.error_code}</code>}
              {canManage && job.retryable && (
                <button
                  onClick={() =>
                    void projectMemoryApi
                      .retryJob(job.job_id, job.retry_count)
                      .then(() => loadView('health'))
                      .catch((cause) => setError(projectMemoryErrorText(cause)))
                  }
                >
                  重试
                </button>
              )}
            </div>
          ))}
          {jobs.length === 0 && <p className="empty">暂无任务</p>}
        </div>
      )}
      {view === 'audit' && (
        <div className="governance-panel">
          <h2>审计</h2>
          {audits.map((audit) => (
            <div className="job-row" key={audit.audit_id}>
              <strong>{audit.operation}</strong>
              <span>{audit.operated_by_user_id}</span>
              <span>{audit.project_id ?? '-'}</span>
              <span>{audit.result}</span>
            </div>
          ))}
          {audits.length === 0 && <p className="empty">暂无审计记录</p>}
        </div>
      )}
    </section>
  );
}
