# 地球 Online · 事件引擎与规则协议 V0.1

> 目标：让开发者仅用 TypeScript、PostgreSQL 和规则配置，实现「玩家输入 → 状态变化 → 条件命中 → 概率抽样 → 际遇/成就」的闭环。不依赖 AI。对照 [核心机制设计](CORE-MECHANICS-v0.1.md)。

## 1. 一条事件的完整生命周期

~~~text
玩家提交结构化事件
  ↓
身份与参数校验（包括时间冲突/重复/提交配额）
  ↓
插入原始事件（带 idempotency_key）
  ↓
按固定顺序计算必然状态变化（成长、疲劳、习惯等）
  ↓
生成本次发生变化的属性索引
  ↓
从索引取出候选规则（而不是扫描全部规则）
  ↓
检查前置条件 + 冷却 + 机会预算 + 社交同意
  ↓
记录一次规则尝试，执行受限随机抽样
  ↓
执行类型安全的效果：更新游戏状态/生成待办际遇/解锁成就
  ↓
记录依赖关系与审计信息
  ↓
写入 outbox，事务提交后由后台通知 UI
~~~

**确定性效果和概率效果必须分开执行。** 学习带来的正常积累不应因「今天没抽中顿悟」而消失。

## 2. 标准事件协议

每条事件具有明确来源：

- self_reported：玩家自行填报的现实行为（未验证现实真实性）。
- system_simulated：游戏内模拟结果（不能被显示为现实事实）。
- multiplayer_confirmed：双方或所有必要参与者确认的共同游戏事件。
- admin_world：已配置的世界公共事件。

示例：

~~~json
{
  "event_id": "evt_01HABC",
  "actor_id": "char_1024",
  "type": "study.completed",
  "source": "self_reported",
  "occurred_at": "2026-10-31T11:00:00Z",
  "duration_minutes": 90,
  "payload": {
    "subject": "math_analysis",
    "method": "problem_solving",
    "difficulty": "intermediate"
  },
  "visibility": "private",
  "idempotency_key": "char_1024:client-c16d",
  "schema_version": 1
}
~~~

约束：

1. 事件类型、科目、方法、难度均来自枚举或维护的字典。
2. 自由文本备注单独存放，不进入规则判定日志，不广播给其他玩家。
3. 同一角色、同一 idempotency_key 只能成功写入一次；重试返回第一次结果。
4. 不能提交超过游戏时长上限或与已有时间区间严重重叠的活动。
5. 多人事件必须有关联邀请与确认记录；不能由一方代替另一方确认。
6. 事件不能凭空从 self_reported 升级为 verified；验证来源与证据另行记录。

## 3. 规则配置模型

**规则是一份数据，不是可执行的外部代码。** 运行器只允许有限的字段路径、比较运算符和效果类型，拒绝 eval 和任意脚本。

规则文件示例见 [math-insight.json](../examples/rules/math-insight.json)。

~~~json
{
  "id": "insight.math.cross-domain",
  "version": 1,
  "enabled": true,
  "listen": ["study.completed", "knowledge.link_created"],
  "scope": "character",
  "require": {
    "all": [
      {"path": "character.skills.math_analysis", "op": "gte", "value": 65},
      {"path": "character.research.math.sessions", "op": "gte", "value": 20},
      {"path": "character.knowledge.cross_domain_links", "op": "gte", "value": 3},
      {"path": "character.state.fatigue", "op": "lte", "value": 75}
    ]
  },
  "chance": {
    "base": 0.015,
    "modifiers": [
      {"path": "character.hidden.associative_thinking", "weight": 0.025},
      {"path": "event.context.new_perspective", "weight": 0.02}
    ],
    "cap": 0.08
  },
  "limit": {"cooldown_days": 14, "window_days": 7, "max_attempts_per_window": 1},
  "effects": [
    {
      "type": "encounter.create",
      "encounter_type": "research_lead",
      "payload": {"domain": "math", "status": "unverified", "requires_choice": true}
    }
  ]
}
~~~

字段解释：

| 字段 | 含义 |
| --- | --- |
| id + version | 规则唯一身份；版本更新不得覆盖历史尝试 |
| listen | 订阅的事件类型，构建候选索引 |
| scope | 运行目标，MVP 只支持 character |
| require | 必须全部成立的条件；后续可支持 any/not |
| chance | 满足条件后的一次概率 |
| limit | 冷却、周期预算、防刷触发限制 |
| effects | 抽中后执行的**白名单效果** |

### 3.1 支持的条件表达式（MVP）

- 比较：eq、neq、gt、gte、lt、lte、in。
- 布尔组合：all、any、not。
- 取值路径：只能读取白名单命名空间 character、event、world 的授权字段。
- 缺失路径：默认条件不成立；不得按 0 自动转换敏感状态。
- 字段类型：数值、布尔、枚举、有限集合；禁止任意运行代码。

### 3.2 概率函数（本版本采用**加法模型**）

~~~text
raw_p = base + Σ(weight_i × normalized_value_i)
p = clamp(raw_p, 0, cap)
triggered = random_roll < p
~~~

- normalized_value_i：0～1 数值；布尔值转成 0 或 1。
- base、weight、cap 必须通过配置校验；p 最终在 0～1。
- 参数属于游戏平衡值，不是现实统计数据。
- 例如上述规则：associative_thinking=0.60 且 new_perspective=true，则 p=0.015+0.025×0.60+0.02=0.05（5%）。
- 条件未通过、仍在冷却、周期尝试数已满时，**不抽样**。
- 同一个源事件与规则版本最多尝试一次；不得通过反复刷新或重试刷新随机数。

### 3.3 随机可复现

- 每次规则尝试写入 opportunity_id、event_id、rule_id、rule_version、p、roll、result。
- 服务端采用加密安全 RNG 或稳定的服务端密钥派生的随机值；不得信任客户端传入的 roll。
- 如果处理事务失败，重试同一条事件应复用首次已分配的尝试 ID 与随机结果。
- 为保护隐藏机制，可只向玩家展示命中的主要条件与结果，不公开密钥或全部隐藏权重。
- 历史回放使用当时的规则版本与持久化结果；不使用当前版本重新抽签。

## 4. 效果协议

MVP 允许的效果：

| 类型 | 作用 |
| --- | --- |
| attribute.add | 增减指定游戏属性，带上下限 |
| knowledge.unlock | 解锁符合前置条件的知识节点 |
| knowledge.link | 在两个已具备的知识节点之间创建关联 |
| encounter.create | 创建待选择或仅展示的游戏内际遇 |
| achievement.unlock | 幂等地解锁成就 |
| cooldown.set | 标记下一次允许触发的时间 |
| event.emit | 发出白名单派生事件，入队后再处理 |

每类效果必须经参数校验。隐藏值只在服务端使用，面向前端返回脱敏结果。

### 4.1 防止事件风暴

- 同一个根事件最多触发 8 层派生事件（初始建议值）。
- 单个根事件最多创建 50 个派生事件（初始建议值）。
- 同一条事件规则组合在同一根事件中不得重复执行（unless 明确配置并经过测试；MVP 一律禁止）。
- 规则执行具有固定排序（优先级 + 规则 ID）。
- 事件循环、越界效果或无效配置直接中止分支并写入错误审计，不影响其他已合法提交的事件。

## 5. 事务、去重和时间

### 5.1 推荐写入事务

~~~text
BEGIN
  SELECT character state FOR UPDATE
  INSERT player_event ON CONFLICT (actor_id, idempotency_key) ...
  如果是重复提交 → 读取已有处理结果，退出
  VALIDATE time budget + prerequisites
  APPLY deterministic state changes
  EVALUATE eligible rule attempts (including rolls)
  INSERT encounter/achievement rows with uniqueness constraints
  INSERT event_dependency + outbox
COMMIT
后台 worker 发布通知并标记 outbox 为已投递
~~~

不要在发出通知之前假定数据库已经成功提交。多人共享事件使用固定的锁排序或更高层的聚合协调，防止死锁与状态冲突。

### 5.2 时间与惰性结算

- MVP 采用现实时间 UTC 存储，前端按用户时区显示。
- 持续属性有 last_settled_at，每次读取或处理相关行为时计算 elapsed 时间差。
- 不允许倒填大量事件造成重复衰减或重复奖励；支持有限追溯窗口和独立历史修订流程。
- 未来预约事件由数据库任务队列执行，不需要持续唤醒每个角色。
- 真实行为时长不是强验证证据；第一版使用逐日时长预算、重叠检测与合理封顶来控制刷取。

## 6. 最小数据库表

| 表 | 关键字段/约束 |
| --- | --- |
| characters | id, owner_id, public_name, created_at, settings |
| character_stats | character_id, stat_key, value, updated_at，唯一(character_id, stat_key) |
| hidden_traits | character_id, trait_key, value, revision，严控读取权限 |
| player_events | id, actor_id, type, source, payload, occurred_at, idempotency_key, status，唯一(actor_id, idempotency_key) |
| rule_definitions | id, version, enabled, config，唯一(id, version) |
| rule_attempts | id, source_event_id, rule_id, rule_version, probability, roll, outcome，唯一(source_event_id, rule_id, rule_version) |
| encounters | id, character_id, rule_attempt_id, type, status, expires_at |
| achievement_unlocks | id, character_id, achievement_id, triggered_by，唯一(character_id, achievement_id) |
| event_dependencies | parent_event_id, child_event_id, relation_type |
| outbox | id, event_type, payload, delivery_status |

后续可加入 knowledge_nodes、knowledge_edges、relationships、world_states、pending_invites 等表。

**访问控制：** 用户不能读取其他人的隐藏特性或私人事件。数据库查询按归属和授权过滤；不能仅靠前端隐藏字段。

## 7. 事件依赖与解释性

因果记录至少区分：

- **derived_from：** 系统规则推导出的直接后续事件；
- **contributed_to：** 某个历史状态为后续机会提供条件；
- **shared_with：** 双方确认的共同事件。

「contributed_to」表示**游戏模拟内部的依赖关系**，不是对现实人生因果关系的科学证明。

玩家侧可以显示：

~~~text
你获得【研究线索】
├─ 前置：数学分析已达到研究门槛
├─ 前置：累积研究活动达到要求
├─ 关联：拥有至少 3 条跨领域知识连接
└─ 本次研究事件获得了特殊际遇
~~~

不可未经授权把另一人的私人历史资料包含在解释里。

## 8. 接口草案

- POST /api/characters：创建角色
- GET /api/characters/me：读取本人角色状态（只返回可见属性）
- POST /api/events：提交结构化行为（带 Idempotency-Key）
- GET /api/events：读取本人事件时间线
- GET /api/encounters：读取待处理际遇
- POST /api/encounters/:id/choose：对际遇作出一次选择
- GET /api/achievements：个人成就图鉴
- GET /api/knowledge：个人已解锁知识图
- 管理端：规则配置检查、离线模拟、审计与回放（不得暴露给普通玩家）

### 8.1 提交事件响应

~~~json
{
  "event_id": "evt_01HABC",
  "accepted": true,
  "provenance": "self_reported",
  "gains": [{"stat": "math_analysis", "delta": 1.2}],
  "encounters": [{"type": "research_lead", "status": "pending_choice"}],
  "achievements": [],
  "replay_id": "replay_123"
}
~~~

请求成功与否以数据库事务结果为准；通知可异步到达。

## 9. 规则测试与验收

### 9.1 必测不变量

1. 重复提交同一事件不重复增长属性、不重复抽签。
2. 同一 source_event + rule + version 的 rule_attempt 仅一条。
3. 属性值、概率、疲劳状态始终在对应合法区间内。
4. 无前置知识时不能直接解锁高阶研究。
5. 未经过第二玩家确认，不能创建双方共同经历。
6. 当冷却未结束时，没有新抽样。
7. 规则升级不改变历史回放结果。
8. 事件链不存在无限递归，任务重试不造成额外奖励。
9. 用户无法读取他人的隐藏特性、非公开事件。
10. 不依赖任何 AI 服务，模拟器可以离线运行。

### 9.2 批量平衡测试

使用不同初始游戏潜变量与行为脚本，自动运行 1,000～10,000 个**虚构角色**的离线事件序列：

- 同等努力条件下，结果应有差异但不完全由出生潜变量决定。
- 研究线索应比基础成长稀有，但不会出现极端不可达或无限刷取。
- 每种高阶成就应能指出可行的达成路径。
- 检查角色跨领域成长、规则死区、永远无法满足的条件。
- 监控每个根事件的平均候选规则数、派生事件数与运行耗时。

## 10. 实现顺序

1. 定义事件 schema、枚举和数据验证。
2. 实现独立于数据库的纯函数规则求值器。
3. 实现确定性成长计算。
4. 实现可复现的概率尝试与测试。
5. 加入持久化、幂等和审计。
6. 加入际遇选择、成就、知识节点。
7. 最后再接入角色页面与事件输入 UI。

**第一条垂直切片目标：** 提交一条「学习数学分析 90 分钟」，看到增长、条件评估、可能产生的研究线索、成就，以及其完整历史。
