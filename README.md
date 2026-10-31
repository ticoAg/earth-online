# 地球 Online · Earth Online

> 玩家决定行为，世界遵循规则，际遇存在不确定性，经历塑造未来。

**Earth Online** 是一款规划中的网页端多人现实人生模拟游戏。玩家记录真实行为与人生事件，游戏通过**事件驱动、规则计算、隐藏属性、概率际遇和长期因果**推演角色成长、际遇与成就。

## 核心方向

- **不依赖 AI**：第一版不接入大语言模型或 AI Agent，使用传统程序和可配置规则引擎。
- **事件驱动**：玩家行为、定时条件与多人交互触发计算，不逐秒模拟全体玩家。
- **非线性成长**：隐藏属性、长期积累、瓶颈、顿悟和环境条件共同影响结果。
- **多人互动**：玩家间的知识分享、帮助与协作，可以产生新的事件和长期影响。
- **现实与模拟分离**：用户自述的真实经历与系统推演的游戏结果明确标记。
- **隐私优先**：个人信息与人生记录默认不公开，社交关系需参与者同意。

## 文档

从 [文档入口](docs/index.md) 查看产品、技术与历史设计；[需求与阶段路线图](docs/product/roadmap.md) 跟踪后续实现与验收。

## 可运行原型

当前代码实现数学学习成长、概率际遇与选择、三类游戏成就、公开角色投影、内存幂等与可复现离线模拟。

- [原型使用说明及已知限制](docs/PROTOTYPE-v0.1.md)
- [SQLite 开发与 D1 迁移计划 V0.2](docs/DATABASE-SQLITE-D1-v0.2.md)
- [自治世界运行与规则发布 V0.1](docs/WORLD-RUNTIME-v0.1.md)：无人在线时世界照常推进；版本切换与维护停服规则。
- [规则引擎源码](src/engine.ts)
- [单元测试](tests/engine.test.ts)
- [批量模拟器](scripts/simulate.ts)

需要 Node.js 22.16+：

~~~bash
npm install
npm run verify
npm run example
~~~

`npm run verify` 依次执行 TypeScript 类型检查、单元测试（含临时 SQLite 数据库验证）及两组各 1,000 个虚构角色的离线模拟（每组 120,000 条事件）。`npm run example` 演示单人玩法。不会接入 AI 或 GPU。

本地数据库演示：

~~~bash
npm run db:migrate
npm run db:seed
npm run db:demo
~~~

默认写入 `.data/earth-online.sqlite`，其中文件及所有测试数据均不会提交到 GitHub。

## 规划中的技术栈

Next.js / TypeScript / Node.js / **SQLite（本地测试）→ Cloudflare D1（计划生产）**；按需引入事件队列，无需 GPU 或 AI API。

## 当前状态

**已有可运行的单人离线玩法原型、SQLite 持久化测试层和自治世界原型。** 暂无网站、账户、真实多人服务和生产 D1；成就和内容仅覆盖首个最小闭环。

## 研发路线

- **P0：** 单角色属性、隐藏特性、事件记录、概率际遇、成就与日志。
- **P1：** 多人关系、协作事件、知识传播和公共事件。
- **P2：** 更丰富的知识网络、长期研究、共享世界模拟和历史演化。

*这是项目的初始产品说明，不代表真实人生预测系统。*

## 自治世界引擎（V0.2）

支持无玩家在线仍可推进世界时间、安排并结算延期公共事件、暂停维护、按世界 tick 生效的新规则版本，并使用 SQLite 记录世界历史。

- [世界运行实现与运行方式](docs/WORLD-IMPLEMENTATION-v0.2.md)
- [自治世界引擎源码](src/world/runtime.ts)
- [本地世界管理命令](scripts/world.ts)
- [Cloudflare scheduled() 示例](src/worker.ts)

```bash
npm run world:demo
npm run world:status
```

以上仅在本地 SQLite 模拟。Cloudflare D1 尚未部署，也未开启公网世界服务。

## 本地 D1 集成测试

```bash
npm ci
npm run test:d1
```

该测试使用 Wrangler 的本地 workerd 和临时 D1 存储，执行迁移并触发 Worker 的 `scheduled()`；验证世界必须先显式启动、零玩家推进、延期任务、重复触发、暂停、CAS 和批量事务回滚。它不需要 Cloudflare 凭据，也不连接或修改远程数据库。[wrangler.local.jsonc](wrangler.local.jsonc) 仅供本地测试，数据库 ID 是占位值，不应部署。测试随 CI 独立运行；生产 D1、管理员鉴权、备份与恢复仍需另行完成和验证。
