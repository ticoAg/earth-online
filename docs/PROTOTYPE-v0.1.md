# 可运行原型说明 · V0.1

## 当前实现范围

这是一个**没有 AI、数据库和 Web 服务**的 TypeScript 离线规则引擎原型。核心代码在 [src/engine.ts](../src/engine.ts)，11 项测试在 [tests/engine.test.ts](../tests/engine.test.ts)。

它包含：

- 数学学习记录（解题、复习、跨学科学习）结构化输入。
- 显性熟练度、可变隐藏特性、疲劳、研究次数和跨领域关联。
- 确定性非线性熟练度成长。
- 白名单规则字段、条件判定、可配置加法概率、一次抽样、冷却及机会次数限制。
- 防重提交（内存幂等）、UTC 活动时间重叠检测、每日四小时上限。
- 模拟内的研究线索事件，与真实个人经历严格区分。
- 一键生成 1,000 个**纯虚构**角色并在每人 120 个模拟日内运行 120,000 条事件。

## 运行

需要 Node.js **22.16.0 或更新的 Node 22 版本**及 npm；运行时不需要 AI API 或 GPU。

~~~bash
npm install
npm run typecheck
npm test
npm run simulate
# 或一次执行全部：
npm run verify
~~~

运行测试使用 Node 内置测试框架和 TypeScript 类型擦除。依赖仅 TypeScript 开发工具；模拟和规则逻辑不依赖第三方运行时包。

## 首轮模拟结果（使用固定的测试随机源）

| 指标 | 结果 |
| --- | ---: |
| 虚构角色数 | 1,000 |
| 每个角色模拟时间 | 120 天 |
| 学习事件总量 | 120,000 |
| 符合规则并执行的抽样次数 | 11,309 |
| 研究线索事件次数 | 360 |
| 至少获得一次线索的角色数 | 311 |
| 最终数学熟练度平均 | 89.69 |
| 熟练度最小值 / 最大值 | 84.37 / 93.66 |

这些数字只体现**当前配置、固定行动脚本、虚构初始属性与可复现测试抽样**的结果，完全不能用于推断真实人生的科研成果概率，也不是经校准的游戏平衡数据。

## API 级函数

- `createWorld(id, initialMath, learningAdaptation, associativeThinking)`
- `validateEvent(world, event)`
- `applyProgression(character, event)`
- `validateRule(rule)`
- `evaluateRules(character, event, rules)`
- `processEvent(world, event, rules, roll?)`

`processEvent` 会返回新世界状态，不会修改旧对象。规则配置示例见 [math-insight.json](../examples/rules/math-insight.json)。

## 已知限制（禁止直接接入真实用户开放服务）

1. **内存状态：** 断电即丢失；幂等仅在当前进程有效，不支持并发事务。
2. **尚无账户认证、数据库、隐私隔离、实时多人通信或管理员审核。**
3. **只有一条数学领域规则。** 当前引擎不是全学科通用游戏，也尚未实现成就系统或玩家关系系统。
4. 概率参数、成长曲线、跨领域联系均为游戏设计假设，尚未调参验证。
5. 离线模拟使用公开可预测的哈希随机源，仅为了测试复现；游戏实服抽签应使用服务端安全 RNG，第一次结果写入事务日志，并保护客户端不可操作。
6. `applyProgression`、`evaluateRules` 是纯计算函数；`processEvent` 还未实现数据库锁、outbox、历史规则版本重放或多端重复提交。
7. 事件输入仅表示玩家自述，不能自动视为经过现实认证的事实。

## 下一步（按优先级）

1. 把引擎转换为依赖最小、可测试的独立 domain 模块；逐步支持更多领域与事件类型。
2. PostgreSQL 持久化：角色、事件、规则尝试、际遇，含幂等唯一约束和事务。
3. 实现明确的成就条件与解锁，不让自由录入直接解锁真实世界奖项。
4. 建立最小网页入口与事件表单、角色面板和时间线。
5. 逐步加入角色关系、双向同意与共享事件；以离线批量实验持续调优。

## 与现有设计文档的关系

[EVENT-ENGINE-v0.1.md](EVENT-ENGINE-v0.1.md) 是**目标协议**；本原型是其可运行子集。

文档中的 `attribute.add`、`event.emit`、`achievement.unlock` 等效果尚未实现；目前只实现 `encounter.create`。规则样例已调整为引擎支持的字段集合（例如 `chance.model = additive`）。请勿将需求文档所有功能理解为已交付。
