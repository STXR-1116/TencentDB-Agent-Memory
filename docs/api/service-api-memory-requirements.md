# 服务 API-记忆库需求文档

本文面向 AI coding 服务端开发人员，定义项目级团队记忆的 HTTP API、权限、数据字段、版本、幂等、异步任务和错误语义。插件设计见 [`插件-记忆库设计文档`](../plugin/plugin-memory-library-design.md)，后台页面见 [`后台管理-记忆库设计文档`](../admin/admin-memory-library-design.md)。

本文是服务端需求和验收依据，不是已部署生产接口的声明。截至 2026-09-03，工作区已交付 OpenClaw 自动 recall/capture 接入、Pi 显式适配器、Web API 客户端和显式启用的确定性 fixture；真实服务端存储、认证、模型、向量检索、异步工作者和部署仍由服务端团队负责。

fixture 仅在 `PROJECT_MEMORY_FIXTURE=true` 时由 MemoryPanel 进程注册，使用固定内存数据验证请求和生命周期交互。它覆盖项目目录、recall、capture、search/list/get/update/delete、项目调整、策略、任务和审计，以及 403、409、503、幂等和删除后过滤；它不实现生产持久化、真实身份提供方、L1 提炼、L2/L3 构建、Embedding、向量检索或真实异步重试。客户端和 fixture 通过不等于该 API 已在真实服务端可用。

## 1. API 目标和边界

服务端是记忆数据、权限和任务状态的唯一事实源。插件与后台只能通过 HTTP API 使用记忆能力；不得让客户端直接访问向量库、L0/L1/L2/L3 文件或内部存储。

首期记忆是 `team + project` 作用域的团队共享记忆。不存在私有记忆、申请共享或人工审核。自动捕获直接进入团队记忆，`captured_by_user_id` 仅用于责任记录和成员自助写权限。产品和 API 不按 Agent 过滤；如果复用现有 MemoryCore 需要 `agent_id`，服务端使用项目级固定内部值，不能出现在公共响应。

首期不向 Wiki、CodeGraph、gbrain 或其他知识库晋升或双写，也不实现知识库撤回。

## 2. 服务端实现应复用的现有能力

服务端应优先复用 TencentDB-Agent-Memory 的既有流水线：

- `MemoryCore` 的 `conversation/add` 接收 L0 消息。
- `MemoryCore` 的 L1 原子事实提炼、混合检索和隔离过滤。
- L2 场景、L3 核心画像的异步构建和读取。
- `PipelineManager` 的排队、重试、空闲检测和派生清理。
- `MemoryProxy` 的身份解析、请求注入和 bridge 入口。
- `MemoryPanel` 使用的 `{ code, message, request_id, data }` 信封、团队上下文和服务端分页模式。

真实服务端新增 `project-memory` 适配层负责：项目授权、项目到内部 memory agent 的映射、统一记录模型、成员写权限、版本控制、幂等、审计和任务查询。不要复制一套 L1 提炼或向量检索实现；fixture 只模拟其公开响应，不能作为复用结论。

## 3. 传输约定

### 3.1 基础路径和方法

所有接口使用 `/v3/project-memory/*`，首期统一使用 `POST`，因为现有 Gateway/Panel 通过 JSON POST 传递上下文和统一信封。未来如需 REST 方法，必须保持同一资源语义和错误码，不新增第二套行为。

### 3.2 认证和身份

请求必须携带现有认证头或等价的 Bearer 认证。服务端从认证上下文得到：

```text
authenticated_user_id, role, organization_ids, team_memberships, project_memberships
```

请求体中的 `user_id`、`role`、组织、团队和项目字段都不能提升权限。服务端必须校验：

1. `project_id` 存在且属于目标 `team_id`。
2. 当前用户属于项目所属团队或具有平台 `admin` 权限。
3. 当前操作的组织范围与角色匹配。
4. 记忆记录当前仍属于请求用户可访问的项目。

项目缺失或上下文无法解析时禁止回退到 `default`。

### 3.3 响应信封

成功和失败均使用：

```json
{
  "code": 0,
  "message": "ok",
  "request_id": "req_opaque",
  "data": {}
}
```

`code=0` 表示业务成功；非零 `code` 必须与 HTTP 状态表达相同失败类别。`request_id` 每次请求唯一，异步任务另返回 `event_id` 和 `job_id`。

### 3.4 ID 和时间

`memory_id`、`project_id`、`team_id`、`event_id`、`job_id`、`request_id` 使用不可枚举的 opaque ID。时间统一使用 ISO 8601 UTC；如底层保留毫秒整数，可在响应中同时提供规范化 ISO 字段，但不得让客户端推断本地时区。

## 4. 资源模型

### 4.1 MemoryRecord

```json
{
  "memory_id": "mem_opaque",
  "team_id": "team_opaque",
  "project_id": "project_opaque",
  "content": "L1 原子事实正文",
  "layer": "L1",
  "captured_by_user_id": "user_opaque",
  "created_at": "2026-09-02T08:00:00Z",
  "updated_at": "2026-09-02T08:03:00Z",
  "revision": 7,
  "status": "ACTIVE",
  "expires_at": null,
  "importance": 0.5,
  "recall_count": 12,
  "last_recalled_at": "2026-09-02T08:05:00Z",
  "source_kind": "agent_turn",
  "source_session_ref": "session_ref_redacted",
  "source_task_ref": "task_ref_redacted"
}
```

客户端可显示正文、捕获人、项目名称、时间、revision、状态和统计。`source_*` 只返回脱敏标识；服务端不得提供原始 Session/Task 正文。`agent_id`、Embedding、检索向量、内部 Prompt 和原始消息不属于公共资源模型。

### 4.2 只读项目目录

如果现有 AI coding 服务端没有项目目录能力，提供：

```text
POST /v3/projects/list
```

请求由认证上下文确定用户，返回可访问项目的 `project_id`、名称、所属 `team_id` 和当前用户角色。该接口只读；项目创建、编辑和删除由其他项目管理能力负责。

### 4.3 Job

```json
{
  "job_id": "job_opaque",
  "event_id": "evt_opaque",
  "kind": "CAPTURE",
  "team_id": "team_opaque",
  "project_id": "project_opaque",
  "status": "PENDING",
  "retry_count": 0,
  "retryable": true,
  "created_at": "2026-09-02T08:00:00Z",
  "started_at": null,
  "finished_at": null,
  "error_code": null,
  "error_message": null,
  "result_ref": null
}
```

任务状态固定为 `PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED`。错误信息必须脱敏，不得包含 Token、原始消息或完整记忆正文。

## 5. 插件运行 API

### 5.1 `POST /v3/project-memory/recall`

用途：在用户消息提交后同步召回当前项目的 L1 记忆。

请求：

```json
{
  "team_id": "team_opaque",
  "project_id": "project_opaque",
  "query": "用户当前问题",
  "session_id": "session_opaque",
  "task_id": "task_opaque"
}
```

`team_id` 允许作为上下文一致性校验，但授权以认证身份和服务端项目关系为准。`top_k`、相关性阈值和 token 预算从生效策略读取，忽略客户端覆盖字段。

成功 `200`：

```json
{
  "code": 0,
  "message": "ok",
  "request_id": "req_opaque",
  "data": {
    "status": "READY",
    "items": [
      {
        "memory_id": "mem_opaque",
        "content": "...",
        "score": 0.82,
        "layer": "L1"
      }
    ],
    "context_text": "仅供参考的记忆上下文",
    "strategy": "hybrid",
    "effective_policy": {
      "top_k": 8,
      "relevance_threshold": 0.4,
      "token_budget": 1200
    }
  }
}
```

`status` 为 `READY`、`PARTIAL` 或 `UNAVAILABLE`。无命中是 `READY` 加空 `items`，不能把服务不可用编码为空命中。召回超时应在约定超时内返回结构化 `UNAVAILABLE`，不阻塞插件原始编码请求。

### 5.2 `POST /v3/project-memory/capture`

用途：在成功回合结束后异步捕获当前回合消息。

请求：

```json
{
  "team_id": "team_opaque",
  "project_id": "project_opaque",
  "session_id": "session_opaque",
  "task_id": "task_opaque",
  "messages": [
    { "role": "user", "content": "...", "timestamp": "2026-09-02T08:00:00Z" },
    {
      "role": "assistant",
      "content": "...",
      "timestamp": "2026-09-02T08:00:03Z"
    }
  ]
}
```

捕获人从认证上下文取得；不接受请求体中的 `user_id`。服务端必须限制消息大小、角色集合和单次回合范围，并过滤已注入的记忆/知识/系统控制块。

成功返回 `202`：

```json
{
  "code": 0,
  "message": "accepted",
  "request_id": "req_opaque",
  "data": {
    "event_id": "evt_opaque",
    "job_id": "job_opaque",
    "status": "PENDING",
    "accepted_count": 2
  }
}
```

同一 `Idempotency-Key` 在有效窗口内必须返回第一次接受结果，不重复创建 L0 记录或捕获任务。项目上下文无效时返回 `PROJECT_CONTEXT_REQUIRED` 或 `PROJECT_ACCESS_DENIED`，不创建任务。

### 5.3 `POST /v3/project-memory/search`

用途：插件记忆库面板的关键词搜索。

请求字段：`project_id`、`query`、`cursor`、`limit`、可选 `status`。服务端限制 `limit` 上限，按当前项目权限执行 L1 搜索并返回：`items`、`next_cursor`、`total_estimate`。搜索不接受 Agent、跨项目或任意 `user_id` 过滤。

### 5.4 `POST /v3/project-memory/list`

用途：插件和后台列表。

请求字段：

```json
{
  "team_id": "team_opaque",
  "project_id": "project_opaque",
  "cursor": null,
  "limit": 50,
  "keyword": "可选关键词",
  "captured_by_user_id": "仅 manage/admin 可用",
  "status": "ACTIVE",
  "created_from": "2026-09-01T00:00:00Z",
  "created_to": "2026-09-02T00:00:00Z",
  "updated_from": null,
  "updated_to": null,
  "layer": "L1"
}
```

服务端按 `updated_at DESC, memory_id DESC` 排序。游标必须绑定完整筛选条件；条件变化时旧游标返回 `INVALID_CURSOR`。普通 `member` 只能查询其当前项目，`manage/admin` 可按权限查询组织范围。

### 5.5 `POST /v3/project-memory/get`

用途：获取单条记忆详情。

请求字段：`memory_id`，可选 `include_layers`。服务端从记录本身解析所属项目并重新鉴权，不接受客户端指定项目来扩大读取范围。响应返回 MemoryRecord、可用的 L2/L3 摘要、脱敏来源摘要、版本和关联任务；不返回 L0 正文。

### 5.6 `POST /v3/project-memory/update`

用途：更新记忆正文。

请求：

```json
{
  "memory_id": "mem_opaque",
  "content": "更新后的 L1 事实",
  "expected_revision": 7
}
```

同时支持 `If-Match: "7"`。两者都出现且不一致时返回 `MEMORY_REVISION_CONFLICT`。服务端只允许修改 `content`；捕获人、team、project、layer、importance、来源、统计和时间字段由服务端维护。

`member` 只有在认证用户等于 `captured_by_user_id` 时允许更新；`manage` 可更新所属组织记录；`admin` 可更新全部记录。成功返回 `200`，包含新 MemoryRecord、新 revision 和派生层刷新 `event_id/job_id`。服务端先让新 revision 成为唯一可召回版本，再异步刷新 L2/L3、Embedding 和索引。

### 5.7 `POST /v3/project-memory/delete`

用途：删除项目团队记忆。

请求字段：`memory_id`、`expected_revision`。必须携带 `Idempotency-Key`。权限与 update 相同。

服务端必须在同步事务中把记录置为不可召回状态，并写入审计；随后异步清理 L1/L2/L3、Embedding、向量索引和缓存。成功接受返回 `202` 和 `event_id/job_id/cleanup_status`。清理失败不能恢复召回，任务进入 `FAILED` 并可由有权限的后台重试。

## 6. 后台治理 API

### 6.1 `POST /v3/project-memory/scope/update`

用途：`manage/admin` 调整记忆所属项目。

请求字段：`memory_id`、`target_project_id`、`expected_revision`。服务端校验操作者对源项目和目标项目的组织权限。成功后旧项目立即过滤，新项目按索引状态进入 `ACTIVE` 或 `INDEX_PENDING`；捕获人、正文、revision 和版本历史保持不变。

该接口不能修改正文、捕获人或团队。返回新项目、revision 和异步刷新任务。

### 6.2 `POST /v3/project-memory/policy/get`

请求字段：`scope_type`（`global/organization/project`）、`scope_id`。返回每个策略字段的 `value`、`source_scope`、`revision` 和 `hard_limit`。

### 6.3 `POST /v3/project-memory/policy/update`

`admin` 可更新全局和组织策略，`manage` 可更新所属组织和项目策略。请求字段包括 `scope_type`、`scope_id`、策略 patch 和 `expected_revision`。项目值只能收紧全局限制，违反限制返回 `POLICY_LIMIT_EXCEEDED`。成功返回新生效策略、revision 和发布任务。

首期字段：`recall_scope=project`、`top_k`、`relevance_threshold`、`token_budget`、`l0_retention_days`（默认 30）和固定 `auto_capture=true`。客户端不能关闭自动捕获。

### 6.4 任务查询和重试

| 接口                                 | 请求                          | 权限                                         |
| ------------------------------------ | ----------------------------- | -------------------------------------------- |
| `POST /v3/project-memory/jobs/get`   | `job_id`                      | 按组织和项目权限                             |
| `POST /v3/project-memory/jobs/list`  | 筛选、游标、limit             | `member` 只看自己；`manage/admin` 按组织范围 |
| `POST /v3/project-memory/jobs/retry` | `job_id`、`expected_revision` | `manage/admin`，仅 `retryable=true`          |

重试使用 `Idempotency-Key`，保留原始失败尝试并生成新的 attempt 记录。已成功、取消或超过重试条件的任务返回 `JOB_NOT_RETRYABLE`。

### 6.5 `POST /v3/project-memory/audit/list`

支持按组织、团队、项目、操作者、角色、操作类型、时间和结果筛选。返回 `audit_id`、操作时间、操作者、角色、memory ID、旧/新项目、旧/新 revision、结果、request ID、event ID 和错误码。不返回原始消息或完整记忆正文。

操作类型至少包括：`CAPTURE_ACCEPTED`、`MEMORY_UPDATED`、`MEMORY_DELETED`、`SCOPE_MOVED`、`POLICY_UPDATED`、`JOB_RETRIED` 和 `INDEX_REFRESHED`。

## 7. 权限矩阵

| 操作                            | `member`   | `manage`     | `admin`      |
| ------------------------------- | ---------- | ------------ | ------------ |
| 当前项目 recall/search/list/get | 允许       | 允许         | 允许         |
| capture                         | 允许       | 允许         | 允许         |
| update/delete 自己捕获的记录    | 允许       | 允许         | 允许         |
| update/delete 他人记录          | 拒绝       | 所属组织允许 | 全部组织允许 |
| scope/update                    | 拒绝       | 所属组织允许 | 全部组织允许 |
| 组织/项目策略                   | 只读       | 所属组织允许 | 全部组织允许 |
| 全局策略                        | 拒绝       | 拒绝         | 允许         |
| 任务查询                        | 自己请求   | 所属组织     | 全部组织     |
| 任务重试                        | 拒绝       | 所属组织     | 全部组织     |
| 审计查询                        | 按可见项目 | 所属组织     | 全部组织     |

权限检查必须在每个读写接口执行，不能依赖前端隐藏控件、路由前缀或底层 agent 分区。

## 8. 错误码和 HTTP 状态

| 错误码                       | HTTP | 触发条件                           |
| ---------------------------- | ---: | ---------------------------------- |
| `PROJECT_CONTEXT_REQUIRED`   |  422 | 缺少/无法解析 project_id           |
| `PROJECT_ACCESS_DENIED`      |  403 | 用户无项目或组织访问权             |
| `MEMORY_NOT_FOUND`           |  404 | 记录不存在或当前用户不可见         |
| `MEMORY_EDIT_FORBIDDEN`      |  403 | member 修改他人捕获记录            |
| `MEMORY_DELETE_FORBIDDEN`    |  403 | member 删除他人捕获记录            |
| `MEMORY_REVISION_CONFLICT`   |  409 | expected revision 或 If-Match 过期 |
| `INVALID_CURSOR`             |  400 | 游标格式错误或筛选条件不匹配       |
| `INVALID_REQUEST`            |  400 | JSON、消息角色、长度或字段不合法   |
| `INDEX_PENDING`              |  202 | 记忆已接受，派生索引未完成         |
| `MEMORY_SERVICE_UNAVAILABLE` |  503 | 存储、Embedding 或依赖不可用       |
| `JOB_NOT_FOUND`              |  404 | 任务不存在或当前用户不可见         |
| `JOB_NOT_RETRYABLE`          |  409 | 任务不可重试                       |
| `POLICY_LIMIT_EXCEEDED`      |  422 | 项目策略试图放宽全局硬上限         |
| `IDEMPOTENCY_CONFLICT`       |  409 | 同一幂等键对应不同请求体           |

所有错误必须包含稳定 `code`、安全 `message` 和 `request_id`。网络异常不能被转换为 `code=0` 加空 `items`。

## 9. 一致性、删除和缓存

### 9.1 版本

正文更新、项目调整和策略更新使用单调递增 `revision`。更新必须原子校验 expected revision；失败不产生新版本。版本历史只追加，不复用被删除的 revision。

### 9.2 删除

删除先写入 tombstone/不可召回状态，再异步清理派生层。召回、搜索、列表和详情在状态切换后立即过滤记录。审计保留删除事实和操作人；首期不提供恢复接口。

### 9.3 派生层刷新

L1 正文是当前可召回事实；L2/L3、Embedding、向量索引和缓存是派生数据。更新后新 L1 revision 立即生效，旧 revision 不能继续进入召回；派生任务完成前返回 `INDEX_PENDING` 或部分状态，不伪造已刷新。

### 9.4 缓存

服务端可以缓存短期召回结果，但缓存键必须包含 `team_id`、`project_id`、权限版本和记忆 revision。删除、过期、项目移动或权限变更时必须使相关缓存失效。插件不得持有可独立召回的事实缓存。

## 10. 异步任务和重试

捕获、正文派生刷新、项目调整、删除清理、策略发布和索引刷新使用统一 Job 模型。任务至少记录创建、开始、结束、attempt、重试次数、错误码、错误摘要和结果引用。

服务端有限次数自动重试瞬时故障；参数错误、权限错误、缺失项目、revision 冲突和能力未配置不重试。后台手动重试必须验证任务仍可重试并使用幂等键。

首期客户端通过查询接口轮询任务，不要求 SSE、Webhook 或长连接事件流。任务状态不应阻塞在线 recall 或编码请求。

## 11. 验收要求

### 权限

1. 项目 A 的成员不能通过 `project_id`、`memory_id`、游标或内部 `agent_id` 读取项目 B。
2. `member` 不能更新或删除他人捕获记录；`manage/admin` 的组织范围准确。
3. 所有后台跨项目操作都写入审计，且记录旧/新项目和 revision。

### 记忆生命周期

1. 成功 Stop 捕获直接接受为项目团队记忆，重复幂等请求不重复写入。
2. 正文更新只改变 content，revision 冲突拒绝覆盖。
3. 删除立即停止 recall/search/list 命中，派生清理失败不恢复召回。
4. 过期记录立即不可召回，清理任务可查询和重试。

### 体验和故障

1. recall 的无命中与服务不可用可区分，不能用空列表伪装故障。
2. 项目缺失、索引处理中、权限失败和服务不可用返回稳定错误码。
3. 任务和审计不泄露 Token、原始消息或敏感正文。
4. 所有列表接口的游标与筛选条件绑定，排序稳定且可复现。

### 边界

首期不实现私有记忆、人工审核、知识库晋升、知识库双写、Agent 绑定、手动创建、召回反馈、原始来源查看、自动捕获开关、SSE 和恢复接口。
