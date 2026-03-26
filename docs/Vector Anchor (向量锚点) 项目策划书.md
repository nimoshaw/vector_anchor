# Vector Anchor (向量锚点) 项目策划书

> **定位**： 为 AI Agent 提供"瞬时目录感知"的轻量化 MCP 向量检索服务。
>
> **核心理念**： 抛弃中心化管理，让知识回归目录。

---

## 一、 产品背景与痛点

在处理复杂的代码项目或庞大的行业知识库（如装修设计案例库、咖啡品牌调研资料）时，Agent 往往面临以下问题：

| 痛点 | 描述 |
|---|---|
| **上下文过载** | 无法一次性读入所有文件，导致 Agent 对项目的认知是碎片化的。 |
| **管理繁琐** | 传统向量数据库（Pinecone、Weaviate）需要启动服务、配置数据库、手动上传文件，链路太长。 |
| **环境脱节** | 切换项目目录时，Agent 难以自动关联对应的知识索引，需要人工"告诉"Agent 去用哪个数据库。 |
| **检索质量低** | 简单的语义相似度搜索容易遗漏弱关联但重要的内容（"只召回字面相似，错过逻辑相关"）。 |

**Vector Anchor 通过在目录内植入"锚点"，实现 Agent 与本地数据的无感缝合。**

### 与 VCP 的关系

Vector Anchor 的灵感深受 [VCPToolBox](https://github.com/lioensky/VCPToolBox) 搜索引擎架构的启发——特别是其 **TagMemo "浪潮"算法** 和 **VSearch 搜索模组** 的设计哲学。但两者的定位有本质区别：

| 对比维度 | VCP TagMemo | Vector Anchor |
|---|---|---|
| **定位** | AI 进化中间层的认知引擎 | Agent 的轻量化目录检索 MCP |
| **部署形态** | 中心化服务端 | 零服务启动，锚点嵌入目录 |
| **检索复杂度** | 7 阶段管线 + LIF 脉冲扩散 | 3 阶段管线（感应→增强→检索） |
| **数据存储** | SQLite + USearch (Rust) | SQLite + anchor-core (Rust N-API) |
| **知识范围** | 全局认知记忆（跨对话、跨 Agent） | 目录级局部知识（随目录而生） |

**我们从 VCP 借鉴的核心思想：**
1. **语义锚点思想**：标签 (Tags) 不只是关键词，它们是语义空间中的"引力源"
2. **残差金字塔**：通过残差分解捕获被宏观概念掩盖的微弱信号
3. **SQLite 嵌入式优先**：零配置部署，ACID 事务保证，WAL 模式并发
4. **动态参数热更新**：检索参数不写死，通过 config 文件热加载

---

## 二、 核心机制：锚定逻辑

Vector Anchor 采用 **"局部自治"** 架构，不依赖任何中央数据库。

### 1. 锚点文件夹 (`.anchor/`)

每个受支持的目录根目录下生成一个 `.anchor` 隐藏文件夹：

```
project_root/
├── .anchor/
│   ├── index.db          # SQLite 数据库（chunks / tags / files / model_meta）
│   ├── vectors.usearch   # HNSW 向量索引（可从 index.db 自动重建）
│   ├── config.json       # 目录级检索策略配置（含父锚点引用 + resolved_model）
│   └── rag_params.json   # 检索参数热更新配置（借鉴 VCP V6）
├── src/
├── docs/
│   └── design/
│       └── .anchor/      # ← 子锚点：仅索引 design/ 下的文件
└── ...
```

#### 各文件职责

| 文件 | 职责 | 备注 |
|---|---|---|
| `index.db` | **唯一数据源**：chunks、tags、共现矩阵、文件清单、模型指纹 | SQLite WAL 模式，ACID 事务 |
| `vectors.usearch` | HNSW 向量索引（加速搜索） | 损坏时可从 index.db 的向量 BLOB 自动重建 |
| `config.json` | 切块策略、忽略列表、模型配置、层级关系 | 支持参数穿透覆盖 |
| `rag_params.json` | 检索超参数（Top-K、相似度阈值、增强因子等） | 热加载，无需重启 |

### 2. 自动寻址算法 (Anchor Resolution)

当 MCP Server 接收到 Agent 的请求时，遵循以下逻辑：

```
  Agent 请求搜索，携带当前工作路径 P
           │
           ▼
  ┌─── P 目录下是否存在 .anchor/ ？───┐
  │ YES                                │ NO
  ▼                                    ▼
  激活该锚点（主锚点）          向父目录递归查找
  扫描父链路上的锚点                   │
  建立层级关系                          ▼
                              ┌── 找到 .anchor/ ？──┐
                              │ YES                  │ NO (到达根目录)
                              ▼                      ▼
                           激活该锚点           返回错误提示：
                                              "当前路径未发现锚点，
                                               请先运行 anchor_init"
```

**核心规则：**
- **就近原则**：总是以距离最近的锚点为主锚点
- **层级感知**：主锚点激活后，自动发现父链路上的所有祖先锚点
- **路径缓存**：首次寻址后缓存解析结果，避免重复遍历

### 3. 锚点层级管理 (Anchor Hierarchy)

> **核心问题**：一个大项目的根目录有锚点，其子目录又被单独建立了锚点，如何管理？

#### 典型场景

```
monorepo/                          ← 根锚点（索引整个仓库）
├── .anchor/
├── packages/
│   ├── frontend/
│   │   └── .anchor/               ← 子锚点 A（仅索引前端代码）
│   └── backend/
│       └── .anchor/               ← 子锚点 B（仅索引后端代码）
├── docs/
│   └── design/
│       └── .anchor/               ← 子锚点 C（仅索引设计文档）
└── shared/
```

#### 层级关系数据模型

子锚点在 `config.json` 中自动记录其父锚点路径：

```jsonc
// packages/frontend/.anchor/config.json
{
  "parent": "../../",              // 指向 monorepo/.anchor/
  "scope": "local",                // 本锚点仅索引当前目录
  "exclude_from_parent": true,     // 父锚点不再索引本目录（避免重复）
  // ...其他配置
}
```

#### 索引的领地规则

**问题**：如果根锚点索引了全部文件，子锚点也索引了一部分文件，岂不是重复了？

**解决方案：排他性领地 (Exclusive Territory)**

```
当子目录建立锚点时：
  │
  ├─ 1. 子锚点的 config.json 自动写入 parent 引用
  ├─ 2. 父锚点的 config.json 自动更新 ignore 列表
  │      └─ 将子锚点目录加入排除名单
  └─ 3. 父锚点触发增量 sync，清除已被子锚点覆盖的 chunks

结果：每个文件只被一个锚点索引，零冗余
```

```jsonc
// monorepo/.anchor/config.json（父锚点，自动更新）
{
  "ignore": [
    "node_modules", ".git",
    "packages/frontend",    // ← 自动添加：该目录已被子锚点接管
    "packages/backend",     // ← 自动添加
    "docs/design"            // ← 自动添加
  ],
  "children": [             // 记录所有直系子锚点
    "packages/frontend",
    "packages/backend",
    "docs/design"
  ]
}
```

#### 检索作用域 (Search Scope)

`anchor_search` 支持 `scope` 参数，控制搜索的范围：

| Scope 模式 | 行为 | 适用场景 |
|---|---|---|
| `local` (默认) | 只搜索当前激活的锚点 | Agent 在子目录中工作，只关心当前上下文 |
| `bubble` | 先搜当前锚点，结果不足时自动向上冒泡至父锚点 | 在子目录中搜索，但可能需要项目全局的信息 |
| `cascade` | 从当前锚点向下搜索所有子锚点 | 从项目根目录搜索，想覆盖所有子模块 |
| `merge` | 合并当前锚点 + 所有祖先锚点 + 所有后代锚点的结果 | 全局搜索，不留死角 |

```typescript
// 使用示例
anchor_search({
  query: "用户鉴权中间件",
  scope: "bubble",     // 先搜本锚点，不够再向上冒泡
  top_k: 10
})
```

**Bubble 模式的工作流（推荐默认模式）**：

```
用户在 packages/frontend/ 下搜索 "数据库连接池配置"
  │
  ├─ Step 1: 搜索 frontend/.anchor/（本地锚点）
  │          └─ 结果: 2 条匹配（不足 top_k=10）
  │
  ├─ Step 2: 冒泡到 monorepo/.anchor/（父锚点）
  │          └─ 结果: 5 条匹配
  │
  └─ Step 3: 合并去重，按相关度排序，返回 Top-7
             └─ 来源标记: [frontend] x2 + [monorepo] x5
```

#### 结果标注

跨锚点搜索的结果会标注来源锚点，让 Agent 清楚知道信息来自哪个作用域：

```jsonc
{
  "results": [
    {
      "content": "...",
      "file_path": "packages/frontend/src/api/auth.ts",
      "anchor_source": "packages/frontend",   // 来自子锚点
      "similarity": 0.92
    },
    {
      "content": "...",
      "file_path": "shared/db/pool.ts",
      "anchor_source": ".",                    // 来自根锚点
      "similarity": 0.85
    }
  ]
}
```

---

### 4. 模型指纹与迁移策略 (Model Fingerprint)

> **核心问题**：用户切换了 Embedding 模型（如从 OpenAI 换到 Ollama，或从 `text-embedding-3-small` 换到 `text-embedding-3-large`），旧向量和新向量处于不同的语义空间，直接混用会导致检索结果完全错乱。

#### 问题本质

```
模型 A 的向量空间          模型 B 的向量空间
┌─────────────────┐      ┌─────────────────┐
│  "猫" → [0.1, 0.8, ...]│  "猫" → [0.5, 0.2, ...]│
│  "狗" → [0.2, 0.7, ...]│  "狗" → [0.6, 0.1, ...]│
└─────────────────┘      └─────────────────┘
         ↑ 这两个空间完全不兼容，不能混在一起搜索
```

#### 模型指纹机制

每个锚点在 `index.db` 中记录当前使用的模型指纹：

```jsonc
// 存储在 index.db 的 model_meta 表中
{
  "model_id": "openai/text-embedding-3-small",  // provider/model 唯一标识
  "dimensions": 1536,                            // 向量维度
  "fingerprint": "a3b8d1...",                    // 模型指纹哈希
  "created_at": "2026-03-25T13:30:00Z"
}
```

**指纹生成方式**：首次索引时，对一组固定的 sentinel 文本（如 `["hello world", "语义检索", "function main()"]`）计算 Embedding，将结果向量拼接后取 SHA256 作为指纹。即使同一模型名称被提供商悄悄更新了权重，指纹也能检测到变化。

#### 启动时检测流程

```
MCP Server 启动 / anchor_search 被调用
  │
  ├─ 1. 读取当前全局配置的 Embedding 模型
  ├─ 2. 对 sentinel 文本计算指纹
  ├─ 3. 与 index.db 中的 model_meta.fingerprint 比对
  │
  ├─ 匹配 ✓ → 正常工作
  │
  └─ 不匹配 ✗ → 触发模型迁移策略
         │
         ├─ 维度不同？ → 必须全量重建（无法兼容）
         └─ 维度相同但指纹不同？ → 可选择迁移策略
```

#### 三种迁移策略

| 策略 | 触发条件 | 行为 | 适用场景 |
|---|---|---|---|
| **全量重建** (rebuild) | 维度变化 / 用户手动选择 | 清空所有向量，用新模型全量重新 Embedding | 模型大升级，向量维度改变 |
| **惰性重建** (lazy) | 维度相同，指纹不同 | 标记所有旧向量为 `stale`，搜索时仍用旧向量，后台逐步用新模型重新计算 | 小规模索引，想要零停机 |
| **降级警告** (warn) | 任何不匹配 | 不做任何迁移，但每次搜索返回警告："当前索引使用的模型与配置不一致，结果可能不准确" | 用户暂时不想重建 |

```typescript
// anchor_init 时可指定迁移策略
anchor_init({
  path: "./",
  options: {
    on_model_change: "lazy"  // "rebuild" | "lazy" | "warn"
  }
})
```

#### 惰性重建 (Lazy Re-embed) 详细流程

```
检测到模型指纹不匹配（维度相同）
  │
  ├─ 1. 在 model_meta 中记录新模型信息，保留旧模型记录
  ├─ 2. 给所有现有 chunks 打上 stale = true 标记
  ├─ 3. 搜索时：
  │      ├─ 新 chunk（非 stale）→ 正常参与检索
  │      └─ 旧 chunk（stale）→ 仍参与检索，但结果中标注 ⚠️
  ├─ 4. 后台任务：空闲时逐批重新 Embedding
  │      └─ 每批完成后更新向量 + 清除 stale 标记
  └─ 5. 全部完成后，清理旧模型记录
```

#### config.json 中的模型迁移配置

```jsonc
// .anchor/config.json
{
  // ...其他配置
  "model_migration": {
    "strategy": "lazy",          // "rebuild" | "lazy" | "warn"
    "lazy_batch_size": 100,      // 惰性重建每批处理的 chunk 数
    "auto_rebuild_threshold": 500 // 索引少于 N 个 chunk 时自动选择全量重建
  }
}
```

---

## 三、 检索引擎设计

> **设计哲学**：借鉴 VCP TagMemo 的"语义引力"思想，但做减法——保留核心算法威力，砍掉 Agent 级认知复杂度。

### 检索管线：3 阶段架构

相比 VCP TagMemo 的 7 阶段管线，Vector Anchor 精简为 **3 个核心阶段**：

#### 阶段一：感应 (Sensing)

```
输入: 用户 Query（自然语言）
  │
  ├─ 1. 文本净化（去除特殊标记、代码噪音）
  ├─ 2. Embedding 投射（获取查询向量 Q）
  └─ 3. 逻辑深度判断（简化版 EPA）
         └─ 判断 Query 是精确查找还是模糊探索
输出: 净化后的查询向量 Q + 检索模式标记
```

**对标 VCP**：简化了 VCP 的 EPA 模块，只保留逻辑深度判断，不做世界观门控和跨域共振分析。

#### 阶段二：增强 (Boost)

```
输入: 查询向量 Q + 标签图谱 (index.db tags 表)
  │
  ├─ 1. 标签感应：Q 投射到 Tag 向量空间，获取 Top-N 匹配标签
  ├─ 2. 残差补偿（简化版残差金字塔）
  │      └─ 从 Q 中剥离已匹配标签的能量
  │      └─ 用残差向量再搜索一轮，捕获弱信号
  ├─ 3. 共现扩展（简化版 LIF 扩散）
  │      └─ 根据 Tag 共现矩阵，1-hop 扩展关联标签
  │      └─ 不做多跳脉冲扩散，控制复杂度
  └─ 4. 向量融合：Q' = normalize(Q + β × ΣTagVectors)
         └─ β 根据逻辑深度动态调整
输出: 增强后的查询向量 Q'
```

**对标 VCP**：
- 保留了 VCP 的**残差金字塔**核心思想（捕获被掩盖的微弱信号）
- **简化 LIF 扩散为 1-hop 共现扩展**（VCP 做 2-hop，但我们目录级知识不需要如此深度的联想）
- 保留了**动态 β 公式**的思路：`β = σ(LogicDepth × log(1 + Coverage))`

#### 阶段三：检索 (Retrieve)

```
输入: 增强后的查询向量 Q' + index.db
  │
  ├─ 1. 向量检索：Q' vs. index.db，取 Top-K 结果
  ├─ 2. 语义去重（简化版 SVD 去重）
  │      └─ 计算结果间的余弦相似度
  │      └─ 合并高度冗余的结果（阈值 > 0.90）
  └─ 3. 结果格式化：返回内容片段、源文件路径、相关度评分
输出: 去重后的 Top-K 检索结果
```

**对标 VCP**：
- 保留了 VCP 的**语义去重**机制（避免返回重复内容）
- 简化了 VCP 的 SVD 主题建模为直接余弦相似度比较

### 标签图谱构建

标签图谱是 Vector Anchor 检索增强的基础，灵感来自 VCP TagMemo 的标签体系：

```
构建时机: anchor_init / anchor_sync 时自动执行
  │
  ├─ 1. 文档切块后，提取每个 chunk 的关键词/概念（通过 LLM 或 TF-IDF）
  ├─ 2. 计算标签的 Embedding 向量
  ├─ 3. 构建共现矩阵：在同一文档/相邻 chunk 中出现的标签互相关联
  └─ 4. 持久化到 index.db 的 tags + tag_cooccurrence 表
```

---

## 四、 功能架构

### 1. MCP 工具集 (Tools)

| 工具名称 | 输入参数 | 功能描述 |
|---|---|---|
| `anchor_init` | `path`, `options?` | 在指定目录初始化锚点，执行首次全量扫描与索引构建。 |
| `anchor_search` | `query`, `top_k?`, `scope?`, `filter?` | **核心接口**。语义搜索。`scope` 支持 `local`/`bubble`/`cascade`/`merge` 四种层级模式。 |
| `anchor_status` | — | 返回当前锚点状态（索引文件数、最后更新时间、数据库大小）。 |
| `anchor_tree` | — | 返回当前锚点的层级树（父锚点、子锚点及其状态）。 |
| `anchor_sync` | `force?`, `recursive?` | 触发增量扫描。`recursive=true` 时同步当前锚点及所有子锚点。 |
| `anchor_tag_inspect` | `tag?` | 查看标签图谱状态；指定 tag 时返回其关联标签和权重。 |
| `anchor_config` | `key`, `value` | 运行时修改检索参数（如 top_k、相似度阈值、增强因子 β）。 |

### 2. 配置管理

#### 全局配置 (首次设置)

> **设计原则**：用户只需要提供最少的信息，其余全部自动探测。

**最小配置（只需 2 个字段）**：

```jsonc
{
  "embedding": {
    "api_key": "sk-...",
    "model": "text-embedding-3-small"
    // 其他全部自动推断 ↓
  }
}
```

**完整配置（全部手动指定时）**：

```jsonc
{
  "embedding": {
    "provider": "openai",                  // 自动推断：从 model 名或 base_url 判断
    "model": "text-embedding-3-small",
    "api_key": "sk-...",
    "base_url": null,                      // 自动推断：provider 对应默认 URL
    "dimensions": null                     // 自动探测：首次调用时检测
  },
  "defaults": {
    "chunk_size": 512,
    "chunk_overlap": 64,
    "top_k": 10,
    "similarity_threshold": 0.3
  }
}
```

#### 智能模型识别机制

**系统内置已知模型注册表：**

| 模型名称 | Provider | 维度 | 备注 |
|---|---|---|---|
| `text-embedding-3-small` | OpenAI | 1536 | 性价比之选 |
| `text-embedding-3-large` | OpenAI | 3072 | 精度最高 |
| `text-embedding-ada-002` | OpenAI | 1536 | 旧版 |
| `models/text-embedding-004` | Google | 768 | Gemini |
| `nomic-embed-text` | Ollama | 768 | 本地开源 |
| `mxbai-embed-large` | Ollama | 1024 | 本地开源 |
| `bge-m3` | Ollama | 1024 | 多语言 |
| `all-minilm` | Ollama | 384 | 超轻量 |

**3 层探测逻辑（首次 `anchor_init` 时执行）：**

```
用户提供 model 名称
  │
  ├─ Layer 1: 内置注册表查询
  │     └─ 命中 → 直接获取 provider + dimensions + base_url
  │
  ├─ Layer 2: 自动探测（注册表未命中时）
  │     ├─ 从 model 名推断 provider（含 "gpt"/"text-embedding" → openai）
  │     ├─ 从 base_url 推断 provider（localhost:11434 → ollama）
  │     └─ 发送一条 probe 请求 embedding("hello")
  │           └─ 从返回的向量长度自动获取 dimensions
  │
  └─ Layer 3: 手动指定（探测失败时的兜底）
        └─ 提示用户："无法自动检测模型维度，请手动配置 dimensions"
```

```typescript
// 内部实现伪代码
async function resolveModelConfig(userConfig: UserConfig): ModelConfig {
  const registry = KNOWN_MODELS[userConfig.model];
  
  if (registry) {
    // Layer 1: 注册表命中
    return {
      provider: userConfig.provider ?? registry.provider,
      dimensions: userConfig.dimensions ?? registry.dimensions,
      base_url: userConfig.base_url ?? registry.base_url,
      ...userConfig
    };
  }
  
  // Layer 2: 自动探测
  const provider = inferProvider(userConfig.model, userConfig.base_url);
  const probeResult = await embed("hello", { ...userConfig, provider });
  const dimensions = probeResult.length;  // 从返回向量长度获取维度
  
  return { provider, dimensions, ...userConfig };
}
```

**探测结果缓存**：首次探测成功后，结果会写入 `.anchor/config.json` 的 `resolved_model` 字段，后续不再重复探测：

```jsonc
// .anchor/config.json（自动写入）
{
  "resolved_model": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "base_url": "https://api.openai.com/v1",
    "probed_at": "2026-03-25T14:00:00Z"
  }
}
```

#### 目录级配置 (`.anchor/config.json`)

```jsonc
{
  "parent": null,                 // 父锚点相对路径（自动填充，null = 根锚点）
  "children": [],                 // 子锚点路径列表（自动维护）
  "exclude_from_parent": true,    // 是否从父锚点的索引中排除本目录
  "ignore": ["node_modules", ".git", "dist", "*.lock"],
  "extensions": [".md", ".ts", ".js", ".py", ".txt", ".json"],
  "chunk_strategy": "auto",      // auto | fixed | semantic
  "chunk_size": 512,
  "chunk_overlap": 64,
  "embedding_model": null        // null = 使用全局配置
}
```

#### 检索参数热更新 (`.anchor/rag_params.json`)

> 借鉴 VCP V6 的 `rag_params.json` 热更新机制

```jsonc
{
  "boost_beta_range": [0.1, 0.5],   // 标签增强因子 β 的动态范围
  "residual_iterations": 2,          // 残差金字塔迭代次数
  "cooccurrence_hop": 1,             // 共现扩展跳数
  "dedup_threshold": 0.90,           // 语义去重阈值
  "tag_recall_top_n": 15,            // 标签感应召回数量
  "min_similarity": 0.25             // 最低相似度过滤门槛
}
```

### 3. 参数穿透

工具调用参数 > `.anchor/rag_params.json` > `.anchor/config.json` > 全局默认配置

---

## 五、 智能切块策略

Vector Anchor 需要针对不同文件类型采用不同的切块策略：

| 文件类型 | 切块策略 | 说明 |
|---|---|---|
| **Markdown** | 按标题层级切块 | 以 `#` / `##` / `###` 为分隔符，保留标题作为上下文 |
| **代码文件** | 按函数/类定义切块 | 利用 AST 解析或正则匹配，保持代码逻辑完整性 |
| **PDF / Docx** | 按段落 + 固定长度 | 先按段落分隔，大段落再按固定长度二次切分 |
| **JSON / YAML** | 按顶层 Key 切块 | 保持数据结构完整性 |
| **纯文本** | 滑动窗口 | 固定长度 + Overlap 的经典方案 |

### 切块元数据

每个 chunk 存储以下元数据：

```typescript
interface ChunkMetadata {
  id: string;              // 唯一标识
  file_path: string;       // 源文件相对路径
  file_hash: string;       // 源文件 SHA256
  chunk_index: number;     // 在文件内的序号
  start_line: number;      // 起始行号
  end_line: number;        // 结束行号
  content: string;         // 原文内容
  heading_context: string; // 所属的标题层级链（如 "二级标题 > 三级标题"）
  tags: string[];          // 自动提取的语义标签
  created_at: string;      // 索引时间
}
```

---

## 六、 技术栈

### 基础架构

| 层级 | 技术选型 | 选型理由 |
|---|---|---|
| **运行时** | Node.js (TypeScript) | MCP SDK 生态成熟，跨平台兼容 |
| **向量引擎** | **`anchor-core` (自研 Rust N-API)** | 参考 VCP vexus-lite，极致性能 |
| **持久化** | SQLite (rusqlite bundled) | WAL 模式，ACID 事务，零配置 |
| **Embedding** | OpenAI / Ollama / 自定义 | 通过 Provider 抽象层支持切换 |
| **协议层** | MCP SDK (@modelcontextprotocol/sdk) | 标准协议，兼容所有 MCP 客户端 |
| **文档解析** | pdf-parse / mammoth / 自研 | Phase 2 支持多格式 |
| **文件监听** | chokidar | Phase 3 实时同步 |

### 自研 Rust 向量引擎：`anchor-core`

> **核心决策**：参考 VCP 的 `vexus-lite` (642 行 Rust 实现)，自研 Rust N-API 向量引擎模块，直接集成 HNSW 索引 + 线性代数运算 + SQLite 持久化。

#### 为什么选择自研 Rust 而非现成方案？

| 对比 | sqlite-vec | LanceDB | 自研 Rust (anchor-core) |
|---|---|---|---|
| **搜索性能** | brute-force，百万级瓶颈 | HNSW，十亿级 | **HNSW (USearch)，十亿级** |
| **数学运算** | ❌ 不支持 | ❌ 不支持 | ✅ **SVD / Gram-Schmidt / EPA** |
| **定制自由** | 受限于 SQLite 扩展 API | 受限于 Lance 格式 | ✅ **完全掌控** |
| **体积** | 小 | 较大 (~50MB) | **小 (~5MB .node)** |
| **N-API 集成** | 需要 better-sqlite3 中间层 | 需要 vectordb npm 包 | ✅ **直接原生调用** |
| **VCP 验证** | — | — | ✅ **同架构，已在生产验证** |

#### 项目结构

```
anchor-core/                        # Rust N-API 原生模块
├── Cargo.toml                      # Rust 包配置
├── build.rs                        # NAPI 构建脚本
├── package.json                    # npm 包配置 + 构建命令
├── index.js                        # Node.js 加载入口（平台检测）
├── index.d.ts                      # TypeScript 类型声明
├── src/
│   ├── lib.rs                      # 主入口 + N-API 导出
│   ├── index.rs                    # HNSW 向量索引封装
│   ├── math.rs                     # SVD / Gram-Schmidt / EPA
│   ├── storage.rs                  # SQLite 持久化层
│   └── types.rs                    # 共享数据类型
└── prebuilds/                      # 预编译原生模块
    ├── anchor-core.win32-x64-msvc.node
    ├── anchor-core.linux-x64-gnu.node
    ├── anchor-core.linux-arm64-musl.node
    └── anchor-core.darwin-arm64.node
```

#### Cargo 配置

```toml
[package]
name = "anchor-core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = "2.16"
napi-derive = "2.16"
usearch = "2.8"              # HNSW 向量索引（VCP 同款）
nalgebra = "0.32"            # SVD / 线性代数
rusqlite = { version = "0.29", features = ["bundled"] }
hashbrown = "0.14"           # 高性能 HashMap
serde = { version = "1.0", features = ["derive"] }
bincode = "1.3"              # 二进制序列化
tokio = { version = "1", features = ["full"] }

[build-dependencies]
napi-build = "2.1"

[profile.release]
lto = true             # 链接时优化
codegen-units = 1       # 最大优化
opt-level = 3           # 最高优化级别
strip = true            # 移除符号
```

#### N-API 接口设计

```typescript
// anchor-core/index.d.ts

/** 搜索结果 */
export interface SearchResult {
  id: number;
  score: number;       // 相似度 (0-1)
}

/** 索引统计信息 */
export interface AnchorStats {
  totalVectors: number;
  dimensions: number;
  capacity: number;
  memoryUsage: number; // 字节
}

/** SVD 分解结果 */
export interface SvdResult {
  u: number[];         // 正交基底 (k × dim 扁平化)
  s: number[];         // 奇异值
  k: number;
  dim: number;
}

/** Gram-Schmidt 正交投影结果 */
export interface ProjectionResult {
  projection: number[];       // 投影向量
  residual: number[];         // 残差向量
  basisCoefficients: number[];// 各标签贡献系数
}

/** EPA 投影结果 */
export interface EpaResult {
  projections: number[];     // 主成分投影值
  probabilities: number[];   // 能量分布概率
  entropy: number;           // 投影熵
  totalEnergy: number;
}

/** 主类 */
export class AnchorIndex {
  // 构造与加载
  constructor(dim: number, capacity: number);
  static load(indexPath: string, dim: number, capacity: number): AnchorIndex;
  save(indexPath: string): void;

  // 向量操作
  add(id: number, vector: Buffer): void;
  addBatch(ids: number[], vectors: Buffer): void;
  search(query: Buffer, k: number): SearchResult[];
  remove(id: number): void;
  stats(): AnchorStats;

  // 高级数学运算（检索增强管线专用）
  computeSvd(vectors: Buffer, n: number, maxK: number): SvdResult;
  computeOrthogonalProjection(
    vector: Buffer, tags: Buffer, nTags: number
  ): ProjectionResult;
  project(
    vector: Buffer, basis: Buffer, mean: Buffer, k: number
  ): EpaResult;

  // 从 SQLite 恢复索引（异步，不阻塞主线程）
  recoverFromSqlite(dbPath: string, tableName: string): Promise<number>;
}
```

#### 与 VCP vexus-lite 的差异

| 方面 | VCP vexus-lite | anchor-core |
|---|---|---|
| **定位** | 全局认知引擎的数学核心 | 目录级检索的完整引擎 |
| **数学运算** | SVD + Gram-Schmidt + EPA + 握手分析 | SVD + Gram-Schmidt + EPA（去掉握手分析，**新增标签共现扩展**） |
| **存储** | 索引与 SQLite 分离 | **索引 + SQLite 统一管理**（原子操作） |
| **多索引** | diaryIndices Map | **锚点层级树**（parent/children） |
| **恢复机制** | 从 SQLite 恢复特定 diary | 从 `.anchor/index.db` 恢复 |
| **新增能力** | — | **标签共现 1-hop 扩展**（Rust 内部计算） |
| **新增能力** | — | **模型指纹校验**（Rust 内部完成） |

#### Rust 核心数据结构

```rust
// src/lib.rs

use std::sync::Arc;
use parking_lot::RwLock;
use usearch::Index;

pub struct AnchorIndex {
    index: Arc<RwLock<Index>>,       // HNSW 索引（线程安全）
    dimensions: u32,
    db_path: Option<String>,          // 关联的 SQLite 路径
}

// 读操作（search, stats）: 共享读锁
// 写操作（add, remove, save）: 独占写锁
// 数学运算（SVD, projection）: 无锁纯计算
```

#### USearch HNSW 配置

| 参数 | 值 | 说明 |
|---|---|---|
| 度量 | L2sq | 对归一化向量等价余弦相似度 |
| 量化 | F32 | 32 位浮点（精度优先） |
| 连接度 | 16 | HNSW 图每个节点的连接数 |
| 添加扩展 | 128 | 添加向量时的候选扩展因子 |
| 搜索扩展 | 64 | 搜索时的候选扩展因子 |

#### 性能目标

| 操作 | 10K 向量 | 100K 向量 | 1M 向量 |
|---|---|---|---|
| 单向量添加 | < 1ms | < 1ms | < 1ms |
| 搜索 (k=10) | < 1ms | < 2ms | < 5ms |
| 批量添加 ×1000 | < 100ms | < 150ms | < 200ms |
| SVD (100 × 1536d) | < 50ms | — | — |
| Gram-Schmidt (50 tags) | < 10ms | — | — |
| SQLite 恢复 | ~500ms | ~5s | ~50s |

#### 跨平台构建

```bash
# 开发构建
cd anchor-core && npm run build:debug

# 发布构建（当前平台）
npm run build

# 多平台 CI 产出
npm run artifacts
```

支持平台：Windows x64, Linux x64 (glibc/musl), Linux ARM64, macOS ARM64 (Apple Silicon)

#### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                  Vector Anchor MCP Server                    │
│                    (Node.js / TypeScript)                     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  MCP Tools   │  │ Search       │  │  Chunk / Tag      │ │
│  │  (anchor_*)  │  │ Pipeline     │  │  Manager          │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────────┘ │
│         │                 │                  │              │
│  ═══════╪═════════════════╪══════════════════╪═══ N-API ═══ │
│         │                 │                  │              │
│  ┌──────┴─────────────────┴──────────────────┴────────────┐ │
│  │              anchor-core (Rust Native)                  │ │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐ │ │
│  │  │  USearch    │  │  nalgebra   │  │    rusqlite      │ │ │
│  │  │  HNSW Index │  │  SVD / GS   │  │  SQLite WAL     │ │ │
│  │  └────────────┘  └────────────┘  └──────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 七、 性能优势与竞品分析

> **核心论断**：我们不需要在 VCP 的战场上赢它。VCP 是全局认知引擎，Vector Anchor 是轻量目录检索。但在我们的战场上，我们可以做到**延迟低 3-5x、更稳定、零配置**。

### 结构性优势

#### 1. 作用域优势：小索引 = 快搜索

VCP 是全局认知引擎，tagIndex 容量 50,000，diaryIndices 动辄上万。Vector Anchor 是**目录级**的——一个典型代码项目只有几千个 chunk。

```
VCP:  搜索 50,000 个 tag 向量 → HNSW ~2-5ms
我们: 搜索  2,000 个 tag 向量 → HNSW < 0.5ms  ← 天然数量级优势
```

**HNSW 搜索时间与数据集大小呈对数关系**，小数据集天然占优。

#### 2. 管线优势：3 阶段 vs 7 阶段

VCP 的 7 阶段管线（EPA → 残差金字塔 → 动态调优 → 语言门控 → LIF 脉冲扩散 → 语义去重 → 向量融合）对全局认知是必要的，但对目录级检索是**过度设计**：

| VCP 步骤 | 我们是否需要 | 理由 |
|---|---|---|
| LIF 多跳脉冲扩散 | ❌ 简化为 1-hop | 目录级知识范围小，不需要深度联想 |
| 语言置信度门控 | ❌ 不需要 | 同一项目语言通常一致 |
| 偏振语义舵 (PSR) | ❌ 不需要 | 面向辩证认知，非搜索场景 |
| 世界观门控 | ❌ 不需要 | 项目内语义维度相对统一 |

**砍掉这些步骤后，E2E 延迟可从 VCP 的 ~50-100ms 降至 ~10-20ms。**

#### 3. 存储优势：统一管理 vs 分离管理

VCP 的 `.usearch` 索引文件与 SQLite **分离管理**，存在同步风险：

```
VCP:  index_global_tags.usearch  ←→  knowledge_base.sqlite
      两处数据分别管理，可能产生"幽灵向量"（索引有但库里没有）

我们: .anchor/index.db (SQLite，BLOB 存原始向量)
      .anchor/vectors.usearch (HNSW 索引，可从 SQLite 自动重建)
      → 单一数据源，SQLite 事务保证一致性
```

**好处**：
- 索引损坏 → 从 SQLite 向量 BLOB **自动重建**，零数据丢失
- 原子事务：`BEGIN...COMMIT` 保证 chunk + 向量 + 标签一致性
- 不可能出现数据不同步的问题

### Rust 级性能优化策略

| 优化方向 | 技术手段 | 预期收益 | 阶段 |
|---|---|---|---|
| **f16 半精度量化** | USearch 支持 F16 量化存储 | 内存减半，搜索加速 ~30%，精度损失 < 1% | Phase 2 |
| **SIMD 向量化** | Rust `std::simd` + 编译器自动向量化 | Gram-Schmidt / 余弦相似度运算加速 2-4x | Phase 1 |
| **mmap 磁盘映射** | USearch mmap 模式 | 大索引免全量加载，冷启动秒开 | Phase 2 |
| **增量共现矩阵** | 只更新变更文件涉及的 tag 对 | VCP 每次全量重建 O(n²)，我们增量 O(Δn) | Phase 2 |
| **PGO 编译优化** | `target-cpu=native` + Profile-Guided Optimization | 针对用户 CPU 微架构极致优化 ~10-15% | Phase 3 |
| **批量 Embedding** | 合并多个 chunk 的 API 调用 | 减少网络往返，索引构建加速 2-3x | Phase 1 |

### 性能对比预测

| 场景 | VCP vexus-lite | anchor-core (预期) | 优势来源 |
|---|---|---|---|
| **向量搜索** (5K chunks) | < 2ms | **< 0.5ms** | 数据量天然小 |
| **完整 E2E 查询** | 50-100ms | **10-20ms** | 3 阶段 vs 7 阶段管线 |
| **冷启动时间** | ~5s (加载多个 .usearch) | **< 1s** | mmap + 单目录单索引 |
| **索引构建** (1K 文件) | ~50s | **~30s** | 增量共现 + 批量 Embedding |
| **索引损坏恢复** | 需要手动触发 | **自动降级 + 自动恢复** | 统一存储层 |
| **内存占用** (10K chunks) | ~120MB (F32) | **~60MB** (F16 量化) | 半精度量化 |

### 诚实的劣势评估

| 方面 | VCP 更强 | 原因 | 我们的应对 |
|---|---|---|---|
| **深度联想** | ✅ LIF 2-hop 脉冲扩散 | 我们只做 1-hop，牺牲了"惊喜联想" | 目录级知识不需要过深联想 |
| **生产验证** | ✅ 已在多场景运行数月 | 我们从零开始 | 充分的自动化测试覆盖 |
| **全局认知** | ✅ 跨对话、跨 Agent 记忆 | 我们有意只做目录级 | 定位不同，不是劣势 |
| **算法复杂度** | ✅ 更丰富的调参控制 | 20+ 个魔法数字动态调控 | 简单 = 稳定，减少调参负担 |

### 差异化竞争力总结

```
┌─────────────────────────────────────────────────────────────────┐
│          我们的核心竞争力 ≠ 更强大   而是 = 更精准的定位          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  VCP: "给 AI 构建完整的存在基础设施"                              │
│       → 全局认知、跨 Agent、永久记忆、分布式协作                   │
│       → 复杂度高、部署重、需要专用服务器                           │
│                                                                 │
│  Vector Anchor: "让目录级知识触手可及"                            │
│       → 零配置、即插即用、随目录而生                               │
│       → 简单 = 稳定 = 快速                                      │
│       → 类比：VCP 是 Oracle，我们是 SQLite                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八、 使用场景示例

### 场景 A：代码项目开发

你在开发一个新功能，Agent 调用 `anchor_search("用户鉴权中间件的实现逻辑")` 自动从 `.anchor` 中找回半年前写的相关逻辑函数，即使这些代码没在当前的上下文窗口里。

```
Agent → anchor_search("用户鉴权中间件") → 返回 3 个相关代码片段
  ├─ src/middleware/auth.ts (L15-L48)  [相关度: 0.92]
  ├─ src/utils/jwt.ts (L5-L30)         [相关度: 0.85]
  └─ docs/auth-flow.md (全文)           [相关度: 0.78]
```

### 场景 B：行业知识库

你有一个存放了上千份"新中式设计案例"的文件夹：

1. 在该文件夹下运行 `anchor_init`
2. 在 Antigravity 中提问："根据我们以往的案例，木质格栅在 10 平米茶室中的比例通常是多少？"
3. Agent 自动通过向量锚点召回相关 PDF 或 Markdown 文档，给出精准回答

### 场景 C：多项目切换

```
你 cd 到项目 A → Agent 自动感知 A/.anchor/ → 搜索 A 的代码
你 cd 到项目 B → Agent 自动感知 B/.anchor/ → 搜索 B 的文档
                 无需任何手动切换配置
```

---

## 九、 演进路线

### Phase 1 — MVP (核心可用)

- [x] 项目策划书完善
- [ ] **`anchor-core` Rust N-API 模块搭建**
  - [ ] Cargo 项目初始化 + napi-rs 配置
  - [ ] USearch HNSW 索引封装 (add / search / remove / save / load)
  - [ ] rusqlite 持久化层 (chunks / tags / files 表)
  - [ ] 跨平台预编译 (Windows x64 / Linux x64 / macOS ARM64)
- [ ] MCP Server 基础架构搭建 (TypeScript)
- [ ] 锚点文件夹初始化 (`anchor_init`)
- [ ] 递归寻址算法实现 (Anchor Resolution)
- [ ] 基础语义检索 (`anchor_search`，不含增强管线)
- [ ] 文件哈希增量更新 (`anchor_sync`)
- [ ] Markdown / 纯文本切块器
- [ ] 锚点状态查询 (`anchor_status`)
- [ ] 模型指纹记录与启动时校验
- [ ] 模型切换检测 + 全量重建 (rebuild) / 降级警告 (warn) 策略
- [ ] 惰性重建 (lazy) 策略（Phase 2 优先）

### Phase 2 — 智能检索

- [ ] **`anchor-core` 高级数学运算**
  - [ ] SVD 奇异值分解 (nalgebra)
  - [ ] Gram-Schmidt 正交投影（残差金字塔核心）
  - [ ] EPA 投影分析（逻辑深度 / 投影熵）
- [ ] 标签图谱自动构建
- [ ] 3 阶段增强检索管线（感应 → 增强 → 检索）
- [ ] 残差补偿搜索
- [ ] 标签共现扩展（1-hop，Rust 内部计算）
- [ ] 语义去重
- [ ] 代码文件 AST 感知切块
- [ ] PDF / Docx 多格式解析
- [ ] `rag_params.json` 热更新
- [ ] `anchor_tag_inspect` 标签检视工具

### Phase 2.5 — 锚点层级管理

- [ ] `anchor_init` 时自动发现并注册父锚点
- [ ] 父锚点自动排除子锚点目录（排他性领地）
- [ ] `anchor_tree` 层级树查看工具
- [ ] `scope` 参数支持：`local` / `bubble` 模式
- [ ] 跨锚点结果合并去重与来源标注
- [ ] `cascade` / `merge` 模式
- [ ] `anchor_sync --recursive` 递归同步

### Phase 3 — 静默同步与高级特性

- [ ] File Watcher 实时索引更新（文件保存即索引）
- [ ] f16 半精度量化（内存减半）
- [ ] mmap 磁盘映射（大索引免加载）
- [ ] 自动识别项目类型并选择切块策略
- [ ] `.anchor/` 的 `.gitignore` 指南生成
- [ ] Web Dashboard（可选，用于可视化标签图谱和锚点层级树）
- [ ] 支持自定义切块策略插件

---

## 十、 数据库 Schema 设计

> SQLite 单文件 (`index.db`)，向量 BLOB 存储于 chunks/tags 表，HNSW 索引由 `anchor-core` Rust 层管理 (`vectors.usearch`)

```sql
-- 模型元信息表（模型指纹）
CREATE TABLE model_meta (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    TEXT NOT NULL,     -- e.g. "openai/text-embedding-3-small"
    dimensions  INTEGER NOT NULL,  -- 向量维度
    fingerprint TEXT NOT NULL,     -- sentinel 文本的哈希指纹
    is_active   BOOLEAN DEFAULT 1, -- 当前活跃模型
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文件清单表（增量更新依据）
CREATE TABLE files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT UNIQUE NOT NULL, -- 相对于锚点根目录的路径
    hash        TEXT NOT NULL,        -- SHA256
    size        INTEGER,
    mtime       INTEGER,              -- 文件修改时间
    indexed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文档块表（向量 BLOB 存储于此，用于 HNSW 索引恢复）
CREATE TABLE chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    start_line  INTEGER,
    end_line    INTEGER,
    content     TEXT NOT NULL,
    heading     TEXT,              -- 标题上下文链
    vector      BLOB,             -- 原始向量（HNSW 索引损坏时用于重建）
    stale       BOOLEAN DEFAULT 0, -- 模型切换后标记
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(file_id, chunk_index)
);

-- 标签表
CREATE TABLE tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    weight      REAL DEFAULT 1.0,
    vector      BLOB,             -- 标签向量
    stale       BOOLEAN DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 文件-标签关联表（用于构建共现矩阵）
CREATE TABLE file_tags (
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, tag_id)
);

-- 标签共现矩阵（缓存，可重建）
CREATE TABLE tag_cooccurrence (
    tag_a_id    INTEGER REFERENCES tags(id),
    tag_b_id    INTEGER REFERENCES tags(id),
    weight      REAL DEFAULT 0.0,
    PRIMARY KEY (tag_a_id, tag_b_id)
);

-- 索引
CREATE INDEX idx_chunks_file_id ON chunks(file_id);
CREATE INDEX idx_chunks_stale ON chunks(stale) WHERE stale = 1;
CREATE INDEX idx_file_tags_tag ON file_tags(tag_id);
```

**注意**：不再使用 `sqlite-vec` / `sqlite-vss` 虚拟表。向量检索完全由 Rust 层的 USearch HNSW 索引处理，SQLite 中的 `vector BLOB` 仅用于持久化存储和索引恢复。

---

## 十一、 错误处理与容灾

### 索引损坏自动恢复

```
系统启动 / anchor_search 被调用
  │
  ├─ 检测 vectors.usearch 是否存在且可加载
  │
  ├─ 正常 ✓ → 直接使用
  │
  └─ 损坏/缺失 ✗ → 自动恢复流程
         │
         ├─ 1. 从 index.db 的 chunks.vector + tags.vector BLOB 重建
         ├─ 2. 异步执行（不阻塞主线程）
         ├─ 3. 重建期间降级为 SQLite brute-force 搜索
         └─ 4. 完成后热切换回 HNSW 索引
```

### 常见错误处理

| 错误场景 | 处理方式 | 用户感知 |
|---|---|---|
| **Embedding API 不可达** | 返回明确错误，不创建空锚点 | "Embedding API 连接失败，请检查网络和 API Key" |
| **SQLite 写入失败** | 事务回滚，重试一次 | "索引更新失败，已回滚" |
| **HNSW 索引损坏** | 自动从 SQLite 重建 | 搜索正常，后台日志提示 "索引已自动重建" |
| **模型维度不匹配** | 阻止操作，提示用户选择迁移策略 | "检测到模型维度变化 (1536→3072)，请选择迁移策略" |
| **磁盘空间不足** | 预检查估算，提前警告 | "预计需要 ~50MB 空间，当前可用 XX MB" |

---

## 十二、 `.gitignore` 与版本控制指南

### 推荐 `.gitignore` 配置

```gitignore
# Vector Anchor 索引数据（不应提交到 Git）
.anchor/index.db
.anchor/index.db-wal
.anchor/index.db-shm
.anchor/vectors.usearch

# 保留配置文件（可提交，团队共享检索策略）
# !.anchor/config.json
# !.anchor/rag_params.json
```

### 什么该提交，什么不该提交

| 文件 | 是否提交 | 理由 |
|---|---|---|
| `config.json` | ✅ **推荐提交** | 团队共享切块策略和忽略列表 |
| `rag_params.json` | ✅ **推荐提交** | 团队共享检索调参 |
| `index.db` | ❌ **不提交** | 二进制文件，体积大，每台机器重新生成 |
| `vectors.usearch` | ❌ **不提交** | 二进制索引，可从 index.db 重建 |

> **`anchor_init` 时自动生成**：如果检测到 `.git` 目录存在，自动在 `.gitignore` 中追加上述规则（如果尚未包含）。

---

## 结语

Vector Anchor 不是要成为另一个数据库产品，也不是 VCP TagMemo 的翻版。

它是 **Agent 的"外挂大脑接口"**——从 VCP 的认知引擎中提炼出最核心的检索增强思想，打包成一个 **零配置、随目录而生、即插即用** 的 MCP 工具。

> 让知识像空气一样，只要你在特定的空间（目录）内，它就触手可及。