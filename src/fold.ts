// src/fold.ts
// Context Folding Module — 独立的上下文折叠模块
//
// 所有折叠策略集中在此文件，与 engine/pipeline 解耦。
// 未来折叠策略的迭代只需修改此文件，不影响项目主体结构。
//
// 5 大创新：
//   ① 意图感知自适应折叠 (Adaptive Thresholds)
//   ② 结构化摘要签名 (Structural Digest)
//   ③ 对话级搜索会话 (Search Session)
//   ④ 渐进式展开协议 (Progressive Disclosure, Levels 0-4)
//   ⑤ Token 预算感知折叠 (Token Budget-Aware)

import type { SearchResultItem, SearchResult } from './engine.js';
import { tokenize } from './pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Pipeline metadata passed from engine search */
export interface PipelineMeta {
  logicDepth: number;
  mode: 'precise' | 'explore';
  matchedTags: string[];
  elapsedMs: number;
}

/** A folded result item with computed display level */
export interface FoldedItem {
  index: number;           // 1-based display index
  result: SearchResultItem;
  level: number;           // 0-4 display level
  formatted: string;       // pre-formatted output text
}

/** Complete folded output from anchor_search */
export interface FoldedOutput {
  sessionId: string;
  items: FoldedItem[];
  summary: string;         // header line with stats
  tokenEstimate: number;
  logicDepth?: number;
  mode?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ① Adaptive Thresholds — 意图感知自适应折叠
// ═══════════════════════════════════════════════════════════════════════════

interface AdaptiveThresholds {
  fullThreshold: number;    // ≥ this → Level 3 (full content)
  summaryThreshold: number; // ≥ this → Level 1 (structural digest)
  // below summary → Level 0 (path only)
}

/**
 * Compute fold thresholds dynamically based on result distribution + pipeline mode.
 * Instead of hardcoded 0.75/0.50, adapts to the actual score landscape.
 */
export function computeAdaptiveThresholds(
  results: SearchResultItem[],
  pipelineMeta?: PipelineMeta,
): AdaptiveThresholds {
  if (results.length === 0) return { fullThreshold: 0.75, summaryThreshold: 0.50 };

  const scores = results.map(r => r.similarity);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length);

  // Logic depth from pipeline sensing: higher = more exploratory query
  const logicDepth = pipelineMeta?.logicDepth ?? 0.5;

  // Precise search → stricter full-expand threshold (only top hits)
  // Explore search → looser threshold (show more detail to aid discovery)
  const fullThreshold = Math.max(0.30,
    mean + std * (logicDepth > 0.6 ? 0.3 : 0.8)
  );
  const summaryThreshold = Math.max(0.20,
    mean - std * 0.3
  );

  return { fullThreshold, summaryThreshold };
}

// ═══════════════════════════════════════════════════════════════════════════
// ② Structural Digest — 结构化摘要签名
// ═══════════════════════════════════════════════════════════════════════════

/** Extract a code signature (function/class/interface declaration) from content */
function extractCodeSignature(content: string): string | null {
  const match = content.match(
    /^[ \t]*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+\w+[^{;]*/m
  );
  return match ? match[0].trim().slice(0, 100) : null;
}

/** Extract top key terms from content (reuses pipeline tokenizer) */
function extractKeyTerms(content: string, n: number): string[] {
  const freq = new Map<string, number>();
  for (const w of tokenize(content)) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

/**
 * Generate a high-density structural digest for Level 1 display.
 * Replaces crude first-line truncation with rich metadata signatures.
 */
export function structuralDigest(r: SearchResultItem): string {
  const parts: string[] = [];

  // Heading context (from chunk metadata)
  if (r.heading) parts.push(`📂 ${r.heading}`);

  // Code signature
  const sig = extractCodeSignature(r.content);
  if (sig) parts.push(`⚡ ${sig}`);

  // Matched tags from pipeline
  if (r.matchedTags?.length) {
    parts.push(`🏷️ ${r.matchedTags.slice(0, 5).join(', ')}`);
  }

  // Residual find annotation
  if (r.isResidualFind) parts.push(`🔍 弱信号发现`);

  // Key term fingerprint (only if we don't have better signals)
  if (!sig && !r.matchedTags?.length) {
    const terms = extractKeyTerms(r.content, 5);
    if (terms.length) parts.push(`📝 ${terms.join(' · ')}`);
  }

  // Fallback: first meaningful line if nothing above produced useful info
  if (parts.length === 0) {
    const firstLine = r.content.split('\n').find(l => l.trim().length > 10)?.trim();
    if (firstLine) parts.push(firstLine.slice(0, 80) + (firstLine.length > 80 ? '...' : ''));
  }

  return parts.join('\n    ');
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ Search Session — 对话级搜索会话
// ═══════════════════════════════════════════════════════════════════════════

interface SessionEntry {
  query: string;
  results: SearchResultItem[];
  pipelineMeta?: PipelineMeta;
  timestamp: number;
}

export class SearchSession {
  private history = new Map<string, SessionEntry>();
  private counter = 0;
  private maxSessions: number;

  constructor(maxSessions = 10) {
    this.maxSessions = maxSessions;
  }

  /** Record a search, return session ID */
  record(query: string, results: SearchResultItem[], pipelineMeta?: PipelineMeta): string {
    const sid = `S${++this.counter}`;
    this.history.set(sid, { query, results, pipelineMeta, timestamp: Date.now() });

    // Evict oldest if over limit
    if (this.history.size > this.maxSessions) {
      const oldest = this.history.keys().next().value;
      if (oldest) this.history.delete(oldest);
    }
    return sid;
  }

  /** Get a specific result from a session */
  getResult(sid: string, index: number): SearchResultItem | null {
    return this.history.get(sid)?.results[index - 1] ?? null;
  }

  /** Get the full session entry */
  getSession(sid: string): SessionEntry | null {
    return this.history.get(sid) ?? null;
  }

  /** Get the latest session */
  latest(): { sid: string; entry: SessionEntry } | null {
    if (this.history.size === 0) return null;
    const entries = Array.from(this.history.entries());
    const [sid, entry] = entries[entries.length - 1];
    return { sid, entry };
  }

  /** List all active sessions (for Agent browsing) */
  list(): Array<{ sid: string; query: string; count: number; age: string }> {
    const now = Date.now();
    return Array.from(this.history.entries()).map(([sid, s]) => ({
      sid,
      query: s.query.slice(0, 60),
      count: s.results.length,
      age: `${Math.round((now - s.timestamp) / 1000)}s ago`,
    }));
  }
}

// Global session instance (shared across all tool calls within one MCP session)
export const searchSession = new SearchSession();

// ═══════════════════════════════════════════════════════════════════════════
// ④ Progressive Disclosure — 渐进式展开协议 (Levels 0-4)
// ═══════════════════════════════════════════════════════════════════════════
//
// Level 0 → 路径 + 相似度
// Level 1 → + 结构化摘要签名
// Level 2 → + 关键段落 (150字精选摘要)
// Level 3 → + 完整内容
// Level 4 → + 邻接 chunk (前后上下文)

/** Format a single result at a given disclosure level */
export function formatAtLevel(r: SearchResultItem, index: number, level: number): string {
  const header = `[${index}] ${r.filePath} (L${r.startLine}-L${r.endLine}) [${r.similarity}]`;

  switch (level) {
    case 0:
      return header;

    case 1:
      return `${header}\n    ${structuralDigest(r)}`;

    case 2: {
      // Key paragraph: pick the most information-dense lines (up to 150 chars)
      const lines = r.content.split('\n').filter(l => l.trim().length > 5);
      const keyLines = lines.slice(0, 4).join('\n').slice(0, 150);
      const digest = structuralDigest(r);
      return `${header}\n    ${digest}\n    ───\n    ${keyLines}${r.content.length > 150 ? '...' : ''}`;
    }

    case 3: {
      const digest = structuralDigest(r);
      return `${header}\n    ${digest}\n    ───\n    ${r.content}`;
    }

    case 4:
      // Level 4 formatting is handled by anchor_read with adjacent chunks
      // Here we format same as Level 3 (adjacents are appended by the caller)
      return formatAtLevel(r, index, 3);

    default:
      return header;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ Token Budget-Aware Folding — Token 预算感知折叠
// ═══════════════════════════════════════════════════════════════════════════

/** Rough token estimation: ~4 chars per token for mixed CJK/Latin */
function estimateTokens(text: string): number {
  // CJK chars ≈ 1-2 tokens each, Latin words ≈ 1 token per 4 chars
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinChars = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + latinChars / 4);
}

/** Estimate tokens for a result formatted at a given level */
function estimateResultTokens(r: SearchResultItem, index: number, level: number): number {
  return estimateTokens(formatAtLevel(r, index, level));
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Entry: foldSearchResults — 将搜索结果折叠成最优输出
// ═══════════════════════════════════════════════════════════════════════════

export interface FoldOptions {
  /** Token budget. If set, auto-selects optimal levels. Default: no limit. */
  maxTokens?: number;
  /** Force a specific level for ALL results. Default: auto. */
  forceLevel?: number;
}

/**
 * Core folding function. Takes raw search results + pipeline metadata,
 * applies all 5 innovations, returns optimally folded output.
 *
 * This is the ONLY function tools.ts needs to call.
 */
export function foldSearchResults(
  searchResult: SearchResult,
  query: string,
  options: FoldOptions = {},
): FoldedOutput {
  const { items: results, pipelineMeta } = searchResult;
  if (results.length === 0) {
    return {
      sessionId: searchSession.record(query, [], pipelineMeta),
      items: [],
      summary: '未找到相关结果。',
      tokenEstimate: 0,
    };
  }

  // Record in session (③)
  const sessionId = searchSession.record(query, results, pipelineMeta);

  // Compute adaptive thresholds (①)
  const thresholds = computeAdaptiveThresholds(results, pipelineMeta);

  // Assign levels to each result
  const foldedItems: FoldedItem[] = [];
  let totalTokens = 0;

  if (options.forceLevel !== undefined) {
    // Force all results to same level
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const level = options.forceLevel;
      const formatted = formatAtLevel(r, i + 1, level);
      const tokens = estimateTokens(formatted);
      foldedItems.push({ index: i + 1, result: r, level, formatted });
      totalTokens += tokens;
    }
  } else if (options.maxTokens) {
    // ⑤ Token budget-aware: greedily assign the highest level that fits
    const budget = options.maxTokens;
    // First pass: calculate cost of Level 0 for all (minimum)
    const minCosts = results.map((r, i) => estimateResultTokens(r, i + 1, 0));
    const totalMin = minCosts.reduce((a, b) => a + b, 0);

    if (totalMin > budget) {
      // Can't even fit all at Level 0 → show as many as possible
      let used = 0;
      for (let i = 0; i < results.length; i++) {
        if (used + minCosts[i] > budget) break;
        const formatted = formatAtLevel(results[i], i + 1, 0);
        foldedItems.push({ index: i + 1, result: results[i], level: 0, formatted });
        used += minCosts[i];
      }
      totalTokens = used;
    } else {
      // Greedy upgrade: start all at Level 0, upgrade highest-similarity first
      const levels = new Array(results.length).fill(0);
      let used = totalMin;

      // Try upgrading each result (sorted by similarity) from 0→1→3
      const upgradeOrder = results.map((_, i) => i)
        .sort((a, b) => results[b].similarity - results[a].similarity);

      for (const targetLevel of [1, 3]) {
        for (const i of upgradeOrder) {
          if (levels[i] >= targetLevel) continue;
          const currentCost = estimateResultTokens(results[i], i + 1, levels[i]);
          const newCost = estimateResultTokens(results[i], i + 1, targetLevel);
          const delta = newCost - currentCost;
          if (used + delta <= budget) {
            // Check adaptive thresholds for Level 3
            if (targetLevel === 3 && results[i].similarity < thresholds.fullThreshold) continue;
            levels[i] = targetLevel;
            used += delta;
          }
        }
      }

      for (let i = 0; i < results.length; i++) {
        const formatted = formatAtLevel(results[i], i + 1, levels[i]);
        foldedItems.push({ index: i + 1, result: results[i], level: levels[i], formatted });
      }
      totalTokens = used;
    }
  } else {
    // Default: ① adaptive threshold-based folding
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let level: number;
      if (r.similarity >= thresholds.fullThreshold) {
        level = 3; // full content
      } else if (r.similarity >= thresholds.summaryThreshold) {
        level = 1; // structural digest
      } else {
        level = 0; // path only
      }
      const formatted = formatAtLevel(r, i + 1, level);
      foldedItems.push({ index: i + 1, result: r, level, formatted });
      totalTokens += estimateTokens(formatted);
    }
  }

  // Build summary header
  const levelCounts = [0, 0, 0, 0, 0];
  for (const item of foldedItems) levelCounts[item.level]++;
  const levelInfo = [
    levelCounts[3] > 0 ? `${levelCounts[3]}条完整` : '',
    levelCounts[1] > 0 ? `${levelCounts[1]}条摘要` : '',
    levelCounts[0] > 0 ? `${levelCounts[0]}条折叠` : '',
  ].filter(Boolean).join('，');

  const sessionNote = `(会话 ${sessionId}，使用 anchor_read 展开详情)`;
  const modeNote = pipelineMeta ? ` [${pipelineMeta.mode === 'explore' ? '探索' : '精确'}模式]` : '';

  return {
    sessionId,
    items: foldedItems,
    summary: `找到 ${results.length} 个结果${modeNote}：${levelInfo} ${sessionNote}`,
    tokenEstimate: totalTokens,
    logicDepth: pipelineMeta?.logicDepth,
    mode: pipelineMeta?.mode,
  };
}

/**
 * Format folded output as a single text string for MCP tool response.
 */
export function foldedOutputToText(output: FoldedOutput): string {
  if (output.items.length === 0) return output.summary;
  const body = output.items.map(item => item.formatted).join('\n\n');
  return `${output.summary}\n\n${body}`;
}

/**
 * Format anchor_read output for a specific result at a requested level.
 * Handles Level 4 (adjacent chunks) when adjacentChunks is provided.
 */
export function formatReadResult(
  r: SearchResultItem,
  index: number,
  level: number,
  adjacentChunks?: SearchResultItem[],
): string {
  let output = formatAtLevel(r, index, Math.min(level, 3));

  // Level 4: append adjacent chunks
  if (level >= 4 && adjacentChunks?.length) {
    const adjText = adjacentChunks.map(adj => {
      const dir = adj.startLine < r.startLine ? '⬆ 前文' : '⬇ 后文';
      return `\n    ─── ${dir} (L${adj.startLine}-L${adj.endLine}) ───\n    ${adj.content}`;
    }).join('');
    output += adjText;
  }

  return output;
}
