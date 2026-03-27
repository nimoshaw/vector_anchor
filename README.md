# Vector Anchor

目录级向量搜索 MCP 服务 — 用于 AI 代码助手的语义检索引擎。

## 功能

- **向量锚点系统**：为任意目录创建 `.anchor` 索引，支持层级继承
- **语义搜索**：基于 HNSW 索引 + TF-IDF Tag 图谱 + 3 阶段检索管线
- **智能分块**：Tree-sitter AST 感知代码切分，保留函数/类边界
- **上下文折叠**：自适应阈值 + Token 预算感知的渐进式展开
- **多模型支持**：OpenAI / Ollama / Google / 自定义（OpenAI 兼容）
- **无感接入**：一键安装、开机自启、MCP 自动注册、IDE 自检

## 一键安装

```powershell
git clone https://github.com/nimoshaw/vector_anchor.git
cd vector_anchor
# 编辑 .env 填入 API Key
.\install.ps1
```

安装脚本自动完成：依赖安装 → TypeScript 编译 → CLI 注册到 PATH → 开机自启 → MCP 配置 → 服务启动。

## 使用

```bash
# CLI 操作
anchor init .              # 初始化当前目录的向量索引
anchor search "用户登录"   # 语义搜索
anchor status              # 查看索引状态
anchor sync                # 增量同步变更
anchor health              # 检查服务状态

# IDE 自检
/anchor-health             # Antigravity 内置健康检查
```

## 环境变量

在 `.env` 文件中配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANCHOR_API_KEY` | Embedding API 密钥 | — |
| `ANCHOR_MODEL` | Embedding 模型名 | `text-embedding-3-small` |
| `ANCHOR_BASE_URL` | API base URL | 按模型自动推断 |
| `ANCHOR_PORT` | HTTP 端口 | `23517` |
| `ANCHOR_SECRET` | Bearer Token（LAN 认证） | 无（不启用认证） |
| `ANCHOR_MAX_MANAGERS` | LRU 缓存最大实例数 | `3` |

## MCP 工具

| 工具 | 说明 |
|------|------|
| `anchor_init` | 初始化向量锚点 |
| `anchor_search` | 语义搜索（支持折叠输出） |
| `anchor_read` | 展开搜索结果详情 |
| `anchor_sync` | 增量同步文件变更 |
| `anchor_status` | 查看索引状态 |
| `anchor_config` | 查看/修改参数 |
| `anchor_tree` | 查看锚点层级树 |
| `anchor_tag_inspect` | 查看标签图谱 |

## 架构

```
src/
├── server.ts        # HTTP MCP 入口（含 MCP 自动注册）
├── index.ts         # stdio MCP 入口
├── tools.ts         # 工具注册与调用
├── engine.ts        # 核心引擎（AnchorManager）
├── pipeline.ts      # 3 阶段检索管线
├── embedding.ts     # 多 Provider Embedding 抽象
├── model.ts         # 模型配置与指纹校验
├── chunker.ts       # 文本分块路由
├── chunker-tree.ts  # Tree-sitter 智能分块
├── chunker-router.ts # 策略分发
├── fold.ts          # 上下文折叠
├── cli.ts           # CLI 客户端（含服务自动拉起）
└── utils.ts         # 通用工具
install.ps1          # 一键安装脚本
```

## License

MIT
