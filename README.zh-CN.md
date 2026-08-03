<p align="center">
  <img src="./assets/readme/hero-zh-cn.svg" width="100%" alt="Agent Skill 在上游版本间更新时，Skills Manager 会保留已批准的 Patch">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

Skills Manager 帮助你安装和更新 Agent Skills，同时不丢失你想保留的改动。**Patch** 是一个经你批准、由 Skills Manager 在 Update 中持续保留的改动。

> [!IMPORTANT]
> `v0.1.0` 是一个**公开预览版**。

## 快速开始

支持的运行时：**Node.js 22 和 24**，以及 **`npx skills >=1.5.19 <2.0.0`**。

```sh
npx skills add Flower-F/skills-manager
```

启动新的 Agent 会话，然后提出需求：

> 查找能够审查前端无障碍性的 Skills，说明最合适的候选项，并在安装任何内容之前让我选择。

Skills Manager 会推荐候选项，并等待你批准确切选择。底层包工具负责作用域、目标 Agent、安全提示和物理安装。

## 使用 Patch 保留改动

<p align="center">
  <img src="./assets/readme/workflow-zh-cn.svg" width="100%" alt="发现并批准 Skill，批准语义化 Patch，然后在 Update 中保留其结果">
</p>

提出一个需要长期保留的自定义请求：

> 让这个 release-notes Skill 始终检查迁移说明，并在后续 Update 中保留这项改动。

Skills Manager 会先提出一个可读的 Patch 等待批准，然后记录结果，而不是脆弱的文件编辑：

```markdown
---
source: owner/repository
skill: release-notes
scope: project
---

# Active Patches

## 检查迁移说明

### Outcome

在起草发布说明前始终检查迁移说明。
```

之后，“更新我安装的 Skills”会推进上游内容并保留每个 Active Patch。实现可以适应新的措辞或文件布局，但改变已批准结果仍需你的批准。已经满足的 Patch 会继续保持 Active，避免后续版本悄然移除该行为。

## 常见请求

- **发现与安装：**“查找发布自动化 Skills，推荐最合适的选项，并让我批准确切选择。”
- **创建 Patch：**“让这个 Skill 的审查始终包含迁移风险，先提出 Patch。”
- **Update：**“更新我的项目 Skills，并保留每个 Active Patch。”
- **一次性编辑：**“这次实验不要创建 Patch。”Skills Manager 会先说明 Update 可能覆盖该改动。
- **Conflict：**如果两个已批准结果无法同时成立，或上游变化使某项结果不安全或含糊，Skills Manager 会说明具体 Conflict 并等待你决定。
- **移除 Patch：**“移除‘检查迁移说明’Patch。”不会保留持久历史或墓碑记录。
- **移除 Installation：**Skills Manager 会展示确切选择；如果最后一个目标及其 Patch 文档将一并消失，会在请求批准前明确说明。
- **Local Skill：**仍可发现、安装、列出和移除，但自定义应维护在本地源中，不创建 Patch 文档。
- **self-Update：**有 Active Patch 的 Skills Manager 不能更新自身。无 Patch 的 self-Update 成功后会要求启动新的 Agent 会话。

## 边界

- 一个 Patch 文档只属于一个确切 Installation，由上游来源、上游 Skill 标识符和项目或全局作用域共同确定；项目与全局文档互相独立。
- 每个文档只包含 Active Patches；每项 Patch 使用唯一可读标题和自包含结果，只在必要时记录理由和约束。
- 只有 Active Patches 受保护。Skills Manager 不会猜测或保留任意手工编辑。
- 所有 Active Patches 必须同时成立，文档顺序不产生优先级。
- 安装与移除选择，以及每次持久 Patch 语义变更，都需要用户批准。
- 如果上游变更失败、超时或在启动后中断，本次操作会停止，不会自动重试或继续 Patch 工作。
- 本项目仅通过 GitHub 分发，不作为 npm 包发布；公开预览期间不支持 `npx skills` 2.x。

## 开发与项目文档

分发内容没有运行时依赖、运行时 helper 或构建步骤。

```sh
npm test
npm run typecheck
npm run check:distribution
```

[贡献指南](CONTRIBUTING.md) · [发布说明](docs/releases/v0.1.0.md) · [架构决策](docs/adr/README.md) · [安全策略](SECURITY.md) · [支持](SUPPORT.md) · [MIT 许可证](LICENSE)
