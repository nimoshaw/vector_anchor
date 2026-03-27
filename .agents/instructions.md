# Vector Anchor 工作区指引

本项目使用 **Vector Anchor** 向量搜索引擎作为 MCP 服务。

## 🔖 启动自检

每次新对话开始时，请**自动执行一次轻量健康检查**（不需要用户要求）：

// turbo
```powershell
Invoke-RestMethod -Uri http://localhost:23517/health -TimeoutSec 3
```

根据结果，在首次回复中**简短附上一行状态提示**：

- ✅ 成功：`🔗 Vector Anchor v{version} 运行中 | {totalVectors} 向量已就绪`
  - 如果需要向量数，调用 `anchor_status` 工具获取
- ⚠️ 失败：`⚠️ Vector Anchor 未运行 — 运行 /anchor-health 查看详情`

> 注意：仅在**首次交互**时检查一次，后续对话不要重复检查。状态提示放在回复末尾，不要影响正文。

## 🛠️ 可用工具

当 Vector Anchor 服务运行时，以下 MCP 工具可用：

| 工具 | 用途 |
|------|------|
| `anchor_search` | 语义搜索代码/文档 |
| `anchor_read` | 展开搜索结果详情 |
| `anchor_init` | 初始化向量索引 |
| `anchor_sync` | 增量同步变更 |
| `anchor_status` | 查看索引状态 |
| `anchor_config` | 查看/修改参数 |
| `anchor_tree` | 查看锚点层级树 |
| `anchor_tag_inspect` | 查看标签图谱 |
