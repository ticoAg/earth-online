# Earth Online 自治世界引擎原型 V0.2

## 功能范围

这个版本实现 **没有玩家在线也能自动结算世界状态** 的底层机制（完全没有 AI 依赖）。目前不是已上线运行的世界服务，也不依赖长期驻留的后台进程。

- `world_runtime`：世界状态 `STOPPED` / `RUNNING` / `PAUSED` / `MAINTENANCE`、世界时钟、资源与调度游标。
- `world_rule_sets`：不可变规则版本；只允许在**未来** tick 生效。
- `world_ticks`：每一个已经成功结算的 tick 都有唯一持久记录。
- `world_events`：确定性的季节切换、周期性世界活动与规则版本切换日志。
- 数据更新使用 SQLite / Cloudflare D1 兼容的 SQL 和原子 `batch()` 事务，防止并发调度造成重复 tick。
- 暂停和维护会冻结逻辑世界时间，恢复后从原有进度继续。
- 同一调度进程设置 `maxTicks` 上限，漏发 Cron 后可以分批追赶，而非一次耗尽处理预算。

## 本地运行（SQLite）

需要 Node.js 22.16+：

```bash
npm install
npm run db:migrate
npm run world:demo
npm run world:status
npm run test
```

`world:demo` 只生成**虚拟世界**，无需账号或真实玩家：以 2026-01-01 为模拟起点，一次结算 30 个世界日；第 7、14、21、28 天触发世界节庆，第 1 天记录春季开始。重复运行不会重复推进这些 tick 或产生重复事件。

默认 SQLite 文件位于 `.data/earth-online.sqlite`，已加入 `.gitignore`。可用 `EARTH_DB_PATH=/tmp/test.sqlite` 替换。

其他命令：

```bash
# 在一份新数据库中手工开启世界
npm run world:init
npm run world:start -- 2026-01-01T00:00:00.000Z
npm run world:advance -- 2026-01-31T00:00:00.000Z

# 停服维护并恢复逻辑时间
npm run world:maintenance -- 2026-01-31T00:00:00.000Z
npm run world:resume -- 2026-02-01T00:00:00.000Z

# 在未来第 40 tick 切换 v2 规则（新规则资源增长倍率为演示固定值）
npm run world:stage -- 2 40
```

CLI 是**本地测试/管理员原型**，暂时没有用户身份认证和线上管理接口；请不要暴露到公网。

## Cloudflare D1 接入准备

- 公共迁移 `migrations/0002_world_runtime.sql` 使用 SQLite 方言，本地与 D1 共用。
- `src/worker.ts` 定义 `scheduled()` 调度入口，假设已有名为 `DB` 的 D1 绑定。
- `wrangler.example.jsonc` 配置样例包含 D1 binding 和 `*/5 * * * *` Cron；数据库 ID 仍是占位值，**不能直接部署**。
- 管理员需要先初始化并开启世界；定时唤醒不应自行开放一个匿名管理员接口。
- 尚未创建或修改你的 Cloudflare D1 数据库，尚未部署 Workers。

## 测试与限制

`tests/world.test.ts` 验证：世界必须显式启动、无人在线连续 30 天模拟、分批追赶、暂停/维护冻结、未来规则版本、并发调度只提交一次以及无效参数拒绝。

初期**规则属于演示游戏参数**，资源变化、季节和节庆都是简单的固定公式，不代表真实地理环境。后续可扩展事件模板、区域状态与派生事件引擎。世界事件目前不触发真实玩家行为，也不会在玩家离线时捏造其现实经历。

性能方面，目前每一个 tick 都执行一次独立读写，适合功能验证；生产需要补上监控、长期追赶预算、调度告警、并发压测和必要的单写者协调（可评估 Durable Objects）。
