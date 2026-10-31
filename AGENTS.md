# 项目协作约定

- 文档入口为 [docs/index.md](docs/index.md)。`docs/product/` 描述产品需求和阶段，`docs/tech/` 描述设计与实现；现有 V0.1 文档保留为设计基线。
- 阶段状态与依赖维护在 [路线图](docs/product/roadmap.md)。实现状态以源码和测试为准；设计、计划与已交付能力必须明确区分。改动影响范围或验收时同步更新路线图。
- 新技术文档使用 OKF 风格 frontmatter：`type`、`title`、`description`、`resource`、`tags`、`status`、`sources`；正文使用与来源 ID 一致的脚注。设计未实现时用 `proposed`，实现并核对后改为 `stable`。不要冒充工具生成的元数据。
- 变更文档或 README 时更新 [docs/log.md](docs/log.md)，日期倒序，记录实际变更。
- 保护现实自述与游戏模拟的来源边界；隐藏特性不是现实能力或健康评估。第一版不依赖 AI。
- 按改动范围选择验证；文档改动至少检查链接和 `git diff --check`。模拟较耗时，除规则或模拟行为变化外不必反复运行完整验证。
