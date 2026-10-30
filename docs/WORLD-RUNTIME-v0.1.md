# 地球 Online · 自治世界运行与规则发布设计 V0.1

> 状态：架构设计草案。尚未实现自动世界后台服务。本文件补充 [核心机制](CORE-MECHANICS-v0.1.md)、[事件引擎](EVENT-ENGINE-v0.1.md) 与 [SQLite → D1 方案](DATABASE-SQLITE-D1-v0.2.md)。

## 一、关键约束

**玩家不在线，世界仍然演化。** 世界的时间进程、周期状态、预定公共事件与可自动推导的世界后果，不依赖是否有在线玩家，也不依赖用户每次打开网页。

但这不代表持续每秒计算每个玩家或模拟无限智能 NPC。默认使用 **世界时钟 + 预约事件 + 定时结算 + 惰性状态更新**。所有行为由确定性算法和规则、随机种子完成，**不依赖 AI**。

必须区分：

1. **真实世界记录**：用户自行报告的现实经历；系统不能在玩家离线时凭空生成现实行为。
2. **虚构游戏世界**：世界环境、公共事件、抽象群体和 NPC 状态可以自动推进；明显标注为模拟。
3. **离线玩家角色**：可自动结算已存在的持续状态/已经接受的任务；不可替用户自动同意其他玩家的交往或申报现实人生经历。

## 二、世界状态机

| 状态 | 意义 | 世界时间 | 世界事件 | 玩家操作 |
| --- | --- | --- | --- | --- |
| STOPPED | 世界尚未启动或已关闭 | 冻结 | 不执行 | 只允许管理员 |
| RUNNING | 正常运行 | 前进 | 到期执行 | 正常 |
| MAINTENANCE | 不兼容规则或结构迁移 | 默认冻结 | 停止新执行，等待处理中任务安全结束 | 只读/维护页 |
| PAUSED | 管理员主动暂停（可选） | 冻结 | 暂缓 | 只读 |

世界启动是持久化的运行状态，而非创建一个永远运行的进程。部署在 Cloudflare Workers 时由 **Cron Triggers** 定时唤起，必要时由请求/队列触发；D1 持久保存时间进度、作业和事件。服务无流量时仍能通过定时调度执行世界任务。

## 三、世界时间与 tick

建议第一版采用 **逻辑 tick**，例如每 5 分钟触发一次调度检查（示例，可配置，非硬性实时保证）。世界自身按逻辑 tick 连续演化，客户端按最后成功结算的世界 tick 展示时间。

- world_id、world_epoch、tick_index、tick_duration、last_processed_at、next_due_at。
- 游戏时间以 `world_epoch + tick_index × tick_duration` 计算，不直接用当前服务器时钟作为已经结算的世界时间。
- Scheduled/Queue 触发可能延迟、失败或重复；每次以数据库存储的 tick 游标确定应该处理的缺失区间。
- 进入维护时冻结逻辑时间；恢复时从冻结游标继续，不把维护期间的墙上时间当作已经发生的世界历史。
- 先处理上次已提交的 tick，再处理下一个 tick，禁止反向或跳过历史。
- 处理落后太多时分段追赶并设置单次最大工作量；作业量超额要报警，不可假装已经结算成功。
- 季节、天气与公共经济趋势可以采用不同的周期；没有事件的 tick 不必批量写入所有玩家状态。

### 第一版无人在线仍应结算的内容

- 时间、季节和区域环境阶段变化（由游戏规则生成，非实时天气预报）。
- 已预约的世界活动和公共事件开始/结束。
- 公共资源周期产出/衰减及世界级进度（如果已实现相应系统）。
- 到期的已接受角色任务、研究线索等；必要时创建待确认的游戏内结果。
- NPC/抽象群体的低频统计状态（可选；不模拟大模型自言自语）。

**不会自动发生：** 玩家虚构的现实恋爱、失业、获奖、真实疾病，未经同意的其他玩家互动或现实经历。

## 四、调度与幂等

建议核心循环：

```text
Cron 定时唤醒 / 后台队列触发
   → 读取 world_runtime
   → 如果不是 RUNNING：结束
   → 领取世界调度权或进行单写者协调
   → 从 last_committed_tick + 1 开始取到期 tick
   → 按规则版本确定每个 tick 的事件候选
   → 确定性条件判断 / 可复现概率抽样
   → 原子写入世界变化、事件历史、规则版本、tick 游标与 outbox
   → 更新进度并释放协调权
```

- 一次逻辑 tick 的同一个世界事件只能应用一次：`UNIQUE(world_id, tick_index, rule_id, opportunity_id)`。
- 规则计算、历史写入、tick 提交必须保证原子性。
- 禁止客户端决定随机数或重试抽签。生产使用服务端密钥派生的可复现抽样或首次持久化 roll。
- 大规模玩家状态变化使用按需结算；世界级状态有独立的持久化与负载预算。
- 在 D1 上使用 SQL 唯一约束、原子 batch/CAS；如出现多 Worker 并发竞争，评估 Durable Objects 做单世界写入协调。
- 监控 lag（当前应处理 tick 与已提交 tick 差）、待结算任务数、错误次数、单 tick 的执行量。

## 五、发布游戏规则：不必每次停服

**默认推荐规则版本化及在 tick 边界原子切换：**

1. 管理员创建新规则版本，状态为 DRAFT。
2. 通过 schema 校验、兼容性检查、离线回放、批量平衡测试。
3. 标记为 APPROVED，配置 `effective_tick`，不能修改已发布旧版本。
4. 到达边界后，所有新的世界事件改用新规则版本；处理中旧 tick 固定使用旧版本。
5. 历史事件继续记录 `rule_id + version + trigger_context + result`，不得回溯重抽。
6. 如需撤回，发布新的回退版本；避免直接删除旧版本或修改既有事实。

### 哪些改动可以不停服

- 新增不影响旧数据的事件、成就或际遇规则。
- 调整未来机会的权重、概率、冷却和上限。
- 更新展示文案、页面和只影响未来事件的可兼容算法。
- 扩充新属性，但有默认值、旧快照兼容和迁移保障。

### 哪些改动通常需要维护模式

- 删除或重命名已经被旧事件、快照引用的关键字段。
- 改变角色状态、知识图或世界时间的基本含义且不兼容旧版本。
- 需要大规模数据迁移、历史修复或重算世界进度。
- 无法在同一时间安全运行新旧版本的重大规则引擎更新。

维护流程：**停止接受新可变更事件 → 安全完成/中止未提交任务 → 冻结逻辑 tick → 保存检查点与备份 → 迁移及验证 → 发布新版本 → 恢复 RUNNING。**

不兼容迁移一定需要计划维护，但不是所有数据库 schema 增量更新都必须停服；遵循向后兼容/扩展-迁移-收缩策略可降低停服次数。

## 六、建议的数据对象（下一阶段增加迁移）

```text
world_runtime
  world_id PK, status, world_epoch, tick_duration_seconds,
  last_committed_tick, active_rule_set_version, revision, updated_at

world_jobs
  id PK, world_id, due_tick, event_type, payload_json,
  state, attempt_count, dedup_key UNIQUE, rule_version

world_events
  id PK, world_id, tick_index, rule_id, rule_version,
  source, payload_json, outcome_json, roll, created_at,
  UNIQUE(world_id, tick_index, rule_id, source_opportunity_id)

world_rule_sets
  version PK, state(DRAFT/APPROVED/ACTIVE/RETIRED), effective_tick,
  config_json, checksum, created_at

world_checkpoints
  id PK, world_id, last_committed_tick, rule_version,
  checkpoint_ref, created_at
```

建议世界状态和玩家角色状态分离。不要复用当前 `player_events` 作为所有世界 tick 的唯一流水表；既有玩家事件可被世界事件引用，但两个生命周期不同。

## 七、运行环境与成本

Cloudflare Workers 并不是传统的长驻内存游戏进程。世界运行由定时触发的 `scheduled()` 与事件队列实现；D1 保存持久化状态，必要时 Durable Objects 协调写入。官方资料：

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers scheduled() handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)

每个 tick 不必查询所有角色。以到期作业索引、事件订阅和按需惰性结算控制读写成本。测试中应包含无人在线 7 天后世界自行推进、调度重复触发、延迟追赶和维护停服恢复。

## 八、验收标准

1. 初始化世界为 STOPPED，管理员启动后世界 tick 开始结算。
2. 零玩家在线时，跨多个 tick 自动发生计划内世界事件。
3. 定时任务漏发后，系统按顺序追赶，不跳 tick、不重复奖励。
4. 同一 tick 因重试/并发多次处理，只产生一次相应世界结果。
5. PAUSED/MAINTENANCE 期间不产生新 tick，恢复时从原游标接续。
6. 兼容规则改动可在有效 tick 切换，不修改已发生历史。
7. 不兼容规则更新进入 MAINTENANCE，检查点与迁移验证完成后恢复。
8. 离线角色只有明确可自动结算的**游戏内状态**变化，不会凭空产生真实人生经历。
9. 历史说明能还原对应世界 tick 和规则版本。
10. 全部机制不调用 AI，也不依赖玩家在线保持世界运行。

## 九、实现顺序

第一步仅模拟一个世界、一个逻辑时钟、季节轮换、少量公共事件和规则版本切换；以本地 SQLite 测试完全无人在线的世界推进。第二步接入 Cloudflare 定时触发和 D1。第三步在已有玩家规则系统上接通世界级际遇，再逐步扩展资源与长期公共进度。

**关键结论：世界自动演化是核心需求；规则版本化优先，只有不兼容更新才进入维护停服。**
