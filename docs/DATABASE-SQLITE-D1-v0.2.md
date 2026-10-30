# SQLite 开发、测试数据与 Cloudflare D1 上线规划（V0.2）

## 状态

- ✅ 本地使用 Node.js 22.16+ 自带的 `node:sqlite`，不依赖数据库服务或 AI。
- ✅ `migrations/0001_initial.sql` 使用 SQLite 方言，同时作为将来 D1 的第一份迁移。
- ✅ 角色、原始事件、规则抽样、际遇持久化到本地文件；重启后可以继续读取，重复提交沿用历史结果。
- ✅ 合成测试数据是固定公式产生的 `synthetic-0000` 等虚构角色，**不含真实玩家资料**。
- 🕒 生产 D1 仅规划好绑定模板与持久化接口；尚未创建 D1、部署 Worker 或接入用户认证。

## 本地开始

需要 Node.js **22.16+**。从仓库根目录运行：

```bash
npm install
npm run db:migrate
npm run db:seed
npm run db:demo
npm test
npm run verify
```

默认 SQLite 文件位于 `.data/earth-online.sqlite`，已加入 `.gitignore`，不会提交到 GitHub。

- `db:migrate`：幂等地创建表与索引。
- `db:seed`：插入 1,000 名确定性的合成角色，已存在则跳过。
- `db:demo`：对 `synthetic-0000` 处理一次结构化数学学习事件，持久化结果并读回状态；重复运行不重复奖励。
- `tests/persistence.test.ts`：使用临时 SQLite 文件验证初始化、重启回放、失败不写入以及并发版本检查。
- 可以使用 `EARTH_DB_PATH=/tmp/earth-test.sqlite npm run db:seed` 指定另一份测试库。

说明：现阶段命令行演示使用可控的测试随机数；未来真实环境要使用服务端安全随机源，并持久化首次抽样。

## 数据库对象

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| characters | 角色当前状态，含仅服务端可见的隐藏特性 | 主键 id、revision_token |
| player_events | 用户输入、幂等键和原始处理结果 | 主键 event id；唯一(character_id, idempotency_key) |
| rule_attempts | 每次有效的概率抽样及版本 | 主键(event_id,rule_id,rule_version) |
| encounters | 游戏模拟产生的际遇 | 主键 id，关联原始事件 |

未来新增登录、真正的多人协作及成就系统时再使用后续迁移，不用覆盖第一份历史迁移。

### 数据隐私

当前表结构包含可见与隐藏状态。**不要直接把数据库绑定或 `loadWorld` 结果暴露给浏览器客户端**。
本阶段尚未实现账号归属、会话认证、鉴权 API、删除与导出流程；因此不允许用于真实个人资料的线上收集。

## 一份规则如何落盘

1. `loadWorld` 将角色状态与历史事件、抽样记录、际遇组装成原有 `World` 对象。
2. 既有 `processEvent` 计算完整下一状态，保留原来规则与概率机制。
3. 使用 `revision_token` 做乐观并发控制（Compare-And-Swap）。
4. 在一次 SQLite 事务 / D1 `batch()` 中修改角色，并把事件与派生记录一并写入。
5. 每一个子写入都检查本次的新随机 revision token；如果另一写入抢先提交，就不写入任何本次子记录，重新读取并计算。
6. 同一 `idempotency_key` 重放时返回原结果，不再抽样。

此架构用于 **MVP**：`loadWorld` 当前会读出一个角色的全部历史事件，时间久了会越来越贵。
正式上线 D1 前应改为**增量状态存储 + 最近窗口规则索引**，避免每次扫描全部历史；当前代码不能代表已经完成大规模性能优化。

## Cloudflare D1 接入路线

D1 基于 SQLite，因此我们保留同一份 SQL 迁移及数据库访问协议（`prepare().bind()` + `batch()`），避免从 PostgreSQL 重新迁移数据库方言。Cloudflare 官方文档：

- [D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 本地开发](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 CLI](https://developers.cloudflare.com/workers/wrangler/commands/d1/)

**将来上线步骤（尚未执行）：**

1. 使用 `npx wrangler d1 create earth-online-production` 在自己的 Cloudflare 账号创建 D1。
2. 复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`，将 `database_id` 改为 Cloudflare 返回的真实 ID。
3. 本地模拟验证：`npx wrangler d1 migrations apply earth-online-production --local`。
4. 在完成认证、访问控制、增量性能测试和备份验证后，再手动执行 `npx wrangler d1 migrations apply earth-online-production --remote`。
5. Workers 环境绑定 `env.DB`，传入持久化模块的 D1 兼容查询接口；**不能**在 Worker 内导入 `node:sqlite` 或 `scripts/local-sqlite.ts`。

重要：D1 的 `batch()` 可以实现事务原子性，但不是直接照搬本地 SQLite 的手写 `BEGIN/COMMIT` 命令。生产要再进行真正 D1 环境下的并发写入、写入预算、复制延迟和错误恢复测试。

### 从 SQLite 导入 D1？

不要把 `.sqlite` 二进制文件直接当成 D1 数据库上传。
如果确实需要迁移数据，应先导出 SQL，再用 Wrangler 导入或通过应用层脚本搬运；本项目当前的 `synthetic-*` 测试数据**不应迁移到真实生产库**。

## 上线前必须补齐

- 用户登录与每次读写的角色归属授权。
- 数据脱敏、私密事件和隐藏属性的权限边界。
- D1 Worker 运行环境的端到端测试。
- 增量快照/窗口索引，避免全量历史回读。
- 用户删除、数据导出、备份和恢复策略。
- 针对并发、网络重试、规则升级的审计和测试。

**目标：同一套游戏规则，不同的存储适配器；本地验证不影响未来上云。**
