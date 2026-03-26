# Vector Anchor — 上下文折叠 V2

> **核心升级**：从静态三层阈值进化为**意图感知 + 自适应 + 预算控制**的智能折叠系统  
> **架构原则**：所有折叠逻辑集中在独立的 `src/fold.ts`，与 engine/pipeline 完全解耦  
> **轻量保证**：零新依赖，零额外 API 调用，所有信号复用 pipeline 已有计算

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    tools.ts (薄适配层)                    │
│  anchor_search → foldSearchResults()                     │
│  anchor_read   → formatReadResult()                      │
└────────────────────────┬────────────────────────────────┘
                         │ 调用
┌────────────────────────▼────────────────────────────────┐
│              fold.ts (独立折叠模块)                       │
│  ┌─────────────┐ ┌──────────────┐ ┌─────────────────┐ │
│  │ ① 自适应阈值 │ │ ② 结构化摘要 │ │ ⑤ Token 预算   │ │
│  └─────────────┘ └──────────────┘ └─────────────────┘ │
│  ┌─────────────┐ ┌──────────────┐                      │
│  │ ③ 搜索会话   │ │ ④ 渐进展开    │                      │
│  └─────────────┘ └──────────────┘                      │
└────────────────────────┬────────────────────────────────┘
                         │ 读取 SearchResult
┌────────────────────────▼────────────────────────────────┐
│  engine.ts (SearchResult + pipelineMeta)                 │
│  pipeline.ts (searchWithMeta → logicDepth, mode, tags)   │
└─────────────────────────────────────────────────────────┘
```

**关键设计决策**：fold.ts 只读取 engine 产出的 `SearchResult`，从不反向调用 engine 的内部方法。唯一例外是 `getAdjacentChunks()`，由 tools.ts 在 Level 4 展开时显式调用。

---

## 改动文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/fold.ts` | **[NEW]** | 独立折叠模块，~290 行 |
| `src/tools.ts` | 修改 | anchor_search 委托 fold.ts + 新增 anchor_read |
| `src/engine.ts` | 修改 | SearchResult 类型 + getAdjacentChunks |
| `src/pipeline.ts` | 修改 | searchWithMeta() 暴露 logicDepth |

---

## 创新 ① 意图感知自适应折叠

**问题**：固定阈值 0.75/0.50 无法适应不同 query 的分数分布。

**方案**：基于结果集的 μ±σ 分布 + pipeline 的 `logicDepth` 动态计算阈值。

```typescript
// fold.ts — computeAdaptiveThresholds()
const fullThreshold = mean + std * (logicDepth > 0.6 ? 0.3 : 0.8);
const summaryThreshold = mean - std * 0.3;
```

- 精确搜索 → 只展开最高分结果
- 探索搜索 → 更多结果获得摘要展示

---

## 创新 ② 结构化摘要签名

**问题**：首行截断丢失太多信息，Agent 需要额外调用才能判断相关性。

**方案**：组装 heading + 代码签名 + 匹配标签 + 关键词指纹。

```
改造前：const pool = new Pool(...
改造后：📂 数据库 > 连接池
        ⚡ class ConnectionPool
        🏷️ database, pool, connection
```

---

## 创新 ③ 对话级搜索会话

**问题**：`lastSearchResults` 只保留最近一次，多轮对话中结果被覆盖。

**方案**：`SearchSession` 类，带 session ID 的搜索历史栈（最近 10 次）。

```
anchor_search → 返回 sessionId: "S3"
anchor_read({ session: "S1", indices: [5] })  ← 回查历史搜索
```

---

## 创新 ④ 渐进式展开协议

| Level | 内容 | ~tokens | 场景 |
|-------|------|---------|------|
| 0 | 路径 + 相似度 | ~20 | 浏览候选 |
| 1 | + 结构化摘要签名 | ~60 | 判断相关性 |
| 2 | + 关键段落 (150字) | ~200 | 理解要点 |
| 3 | + 完整内容 | ~400 | 阅读实现 |
| 4 | + 邻接 chunk 上下文 | ~800 | 深入分析 |

```typescript
anchor_read({ indices: [1, 3], level: 4 })  // 含前后上下文
```

---

## 创新 ⑤ Token 预算感知折叠

```typescript
anchor_search({ query: "连接池配置", max_tokens: 800 })
// 自动在 800 token 内选最优折叠：
// → 前 2 条 Level 3, 后 3 条 Level 1, 剩余 Level 0
```

**算法**：贪心策略，高相似度结果优先升级 Level。

---

## 工具接口

### `anchor_search` (改造)

```typescript
anchor_search({
  query: string,           // 查询
  top_k?: number,          // 返回数量
  scope?: 'local' | 'bubble' | 'cascade' | 'merge',
  min_similarity?: number,
  max_tokens?: number,     // ⑤ Token 预算
  level?: number,          // 强制所有结果的展开级别
})
```

### `anchor_read` (新增)

```typescript
anchor_read({
  indices: number[],       // 结果序号
  session?: string,        // ③ 会话 ID（默认最近一次）
  level?: number,          // ④ 展开级别 0-4（默认 3）
})
```

---

## 效果预估

| 场景 | V1 | V2 | 改进 |
|:-----|:---:|:---:|:----:|
| 10 条结果，默认输出 | ~2000 tokens | ~600 (自适应) | **70%** |
| 探索式查询 | 同上 | ~900 (更多摘要) | **55%** |
| max_tokens=500 | 不支持 | ~500 (精确控制) | **精确** |
| 多轮搜索回查 | 覆盖丢失 | 完整保留 | **∞** |

---

## 未来迭代方向

`fold.ts` 作为独立模块，以下增强只需修改此文件：

- [ ] LLM 辅助摘要（Level 2 用 LLM 生成精选段落）
- [ ] 文件类型感知折叠（代码 vs 文档用不同摘要策略）
- [ ] 结果聚类折叠（相似结果合并展示）
- [ ] 用户偏好学习（记录 Agent 的展开模式，自动优化默认 Level）
