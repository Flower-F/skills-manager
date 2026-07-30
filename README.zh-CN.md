<p align="center">
  <img src="./assets/readme/hero-zh-cn.svg" width="100%" alt="Skills Manager 在上游 Agent Skill 更新时保留用户已批准的语义化 Intent">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

Skills Manager 通过 `npx skills` 管理 Agent Skills，并在上游内容发生变化时保留你已批准的行为。

> [!IMPORTANT]
> `v0.1.0` 是一个**公开预览版**，工作流和 Intent 格式可能会发生变化。

## 快速开始

支持的运行时：**Node.js 22 和 24**，以及 **`npx skills >=1.5.19 <2.0.0`**。

```sh
npx skills add Flower-F/skills-manager
```

启动一个新的 Agent 会话，然后提出需求：

> 查找能够审查前端无障碍性的 Skills，说明最合适的候选项，并在安装任何内容之前让我选择。

## 核心体验

<p align="center">
  <img src="./assets/readme/workflow-zh-cn.svg" width="100%" alt="通过 npx skills 选择 Skill，批准并记录语义化 Intent，然后在上游 Update 后重新应用并审查">
</p>

1. **发现**——描述你的需求；Agent 会查找并说明相关的 Skills。
2. **安装**——批准确切的 Skill 选择；`npx skills` 负责作用域、目标 Agent、安全提示和安装。
3. **自定义**——描述你想要的行为；Skills Manager 会先将其记录为 Intent，再编辑已安装的 Skill。
4. **更新**——发起更新请求；上游内容更新后，每个有效的 Intent 都会以语义化方式重新应用并接受审查。

例如：

> 自定义这个 Installation，让它始终检查迁移说明，并将这一结果保存为 Intent。

Skills Manager 记录的是期望结果，而不是脆弱的文本补丁：

```markdown
---
source: owner/repository
skill: release-notes
scope: project
---

# Active Intents

- Always check migration notes before drafting release notes.
```

之后，“更新我已安装的 Skills 并保留所有有效的 Intent”会更新上游 Skill，并在维持已批准结果的同时调整具体实现。任何语义变更仍然需要你的批准。

## 边界

- `npx skills` 始终是唯一的包管理器。Skills Manager 在此基础上提供推荐、批准、Intent 和语义化重新应用能力。
- 项目级和全局 Installation 分别维护独立的 Intent 文档。
- Local Skill 不支持受跟踪的上游 Update，也不支持与干净上游版本进行比较。
- 本项目仅通过 GitHub 分发，不会发布为 npm 包；公开预览期间不支持 `npx skills` 2.x。

> [!CAUTION]
> Intent 应用补丁是原始内容，**不会自动脱敏**。它们可能会在终端输出、Agent 对话或共享日志中暴露私有 Skill 内容。请避免在 Skills 中存放凭据，并在分享前检查输出内容。

## 开发与项目文档

本项目的实现没有运行时依赖，也不需要构建步骤。

```sh
npm test
npm run typecheck
npm run check:distribution
```

[贡献指南](CONTRIBUTING.md) · [发布说明](docs/releases/v0.1.0.md) · [架构决策](docs/adr/README.md) · [安全策略](SECURITY.md) · [支持](SUPPORT.md) · [MIT 许可证](LICENSE)
