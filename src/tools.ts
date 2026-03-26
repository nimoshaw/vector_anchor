// src/tools.ts
// Config-driven MCP tool registry + definitions (all-in-one)

import { z } from 'zod';
import { AnchorManager, resolveAnchor } from './engine.js';
import { loadAnchorConfig, loadRagParams, logger } from './utils.js';
import { foldSearchResults, foldedOutputToText, formatReadResult, searchSession, type FoldOptions } from './fold.js';

// ═══════════════════════════════════════════════════════════════════════════
// Tool registry
// ═══════════════════════════════════════════════════════════════════════════

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
export interface ToolContext { cwd?: string; }
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const tools = new Map<string, ToolDefinition>();
function reg(def: ToolDefinition) { tools.set(def.name, def); }
export function getAllTools(): ToolDefinition[] { return Array.from(tools.values()); }
export function getTool(name: string) { return tools.get(name); }
function ok(text: string): ToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): ToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function json(data: unknown): ToolResult { return ok(JSON.stringify(data, null, 2)); }

// ═══════════════════════════════════════════════════════════════════════════
// Shared state
// ═══════════════════════════════════════════════════════════════════════════

let globalApiKey = '';
let globalModel = 'text-embedding-3-small';
let globalBaseUrl = '';
export function setGlobalEmbedding(apiKey: string, model: string, baseUrl?: string) {
  globalApiKey = apiKey;
  globalModel = model;
  if (baseUrl) globalBaseUrl = baseUrl;
}

import { resolve } from 'node:path';

const managers = new Map<string, AnchorManager>();
function mgr(root: string): AnchorManager {
  const key = resolve(root);
  let m = managers.get(key);
  if (!m) { m = new AnchorManager(key); managers.set(key, m); }
  return m;
}

const sizeStr = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

/** Resolve anchor + set embed options in one call */
function ensureMgr(cwd: string): { m: AnchorManager; anchor: ReturnType<typeof resolveAnchor> } | null {
  const anchor = resolveAnchor(cwd);
  if (!anchor) return null;
  const m = mgr(anchor.projectRoot);
  const cfg = loadAnchorConfig(anchor.anchorDir);
  if (cfg.resolved_model) {
    m.setEmbedOptions({ apiKey: globalApiKey, resolved: cfg.resolved_model });
  }
  return { m, anchor };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════════════════

export function registerAllTools() {

  reg({
    name: 'anchor_init',
    description: '在指定目录初始化向量锚点，全量扫描与索引构建。',
    inputSchema: z.object({
      path: z.string().describe('目录路径'),
      options: z.object({
        on_model_change: z.enum(['rebuild', 'lazy', 'warn']).optional(),
        force: z.boolean().optional(),
      }).optional(),
    }),
    handler: async (args) => {
      if (!globalApiKey) return err('未配置 ANCHOR_API_KEY 环境变量。');
      try {
        return ok(await mgr(args.path).init(globalApiKey, globalModel, globalBaseUrl, {
          force: args.options?.force,
          onModelChange: args.options?.on_model_change,
        }));
      } catch (e) { return err(`anchor_init: ${e instanceof Error ? e.message : e}`); }
    },
  });

  reg({
    name: 'anchor_search',
    description: '语义搜索锚点索引。支持自适应折叠输出、Token 预算控制。返回分层结果，使用 anchor_read 展开详情。',
    inputSchema: z.object({
      query: z.string().describe('搜索查询'),
      top_k: z.number().optional(),
      scope: z.enum(['local', 'bubble', 'cascade', 'merge']).optional(),
      min_similarity: z.number().optional(),
      max_tokens: z.number().optional().describe('Token 预算上限，自动选择最优折叠级别'),
      level: z.number().min(0).max(4).optional().describe('强制所有结果的展开级别 (0=路径, 1=签名, 3=完整)'),
    }),
    handler: async (args, ctx) => {
      try {
        const res = ensureMgr(ctx.cwd ?? process.cwd());
        if (!res) return err('未找到锚点。请先运行 anchor_init。');
        const searchResult = await res.m.search(args.query, { topK: args.top_k, minSimilarity: args.min_similarity, scope: args.scope as any });

        // Fold results using the independent fold module
        const foldOpts: FoldOptions = {};
        if (args.max_tokens !== undefined) foldOpts.maxTokens = args.max_tokens;
        if (args.level !== undefined) foldOpts.forceLevel = args.level;

        const folded = foldSearchResults(searchResult, args.query, foldOpts);
        return ok(foldedOutputToText(folded));
      } catch (e) { return err(`anchor_search: ${e instanceof Error ? e.message : e}`); }
    },
  });

  reg({
    name: 'anchor_read',
    description: '展开搜索结果的详情。支持指定展开级别和历史会话回查。',
    inputSchema: z.object({
      indices: z.array(z.number()).describe('结果序号列表，如 [1, 3]'),
      session: z.string().optional().describe('搜索会话 ID，如 "S1"。不填则使用最近一次搜索'),
      level: z.number().min(0).max(4).default(3).describe('展开级别: 0=路径, 1=签名, 2=关键段, 3=完整, 4=含邻接上下文'),
    }),
    handler: async (args, ctx) => {
      try {
        // Resolve session
        const targetSession = args.session
          ? searchSession.getSession(args.session)
          : searchSession.latest()?.entry;
        if (!targetSession) return err('无搜索记录。请先执行 anchor_search。');

        // Resolve anchor manager for adjacent chunk queries
        const res = args.level >= 4 ? ensureMgr(ctx.cwd ?? process.cwd()) : null;

        const parts = args.indices.map((idx: number) => {
          const r = targetSession.results[idx - 1];
          if (!r) return `[${idx}] 无效序号`;

          // Get adjacent chunks for Level 4
          let adjacents: import('./engine.js').SearchResultItem[] | undefined;
          if (args.level >= 4 && res) {
            adjacents = res.m.getAdjacentChunks(r.filePath, r.startLine);
          }

          return formatReadResult(r, idx, args.level, adjacents);
        });

        return ok(parts.join('\n\n---\n\n'));
      } catch (e) { return err(`anchor_read: ${e instanceof Error ? e.message : e}`); }
    },
  });

  reg({
    name: 'anchor_sync',
    description: '增量同步文件变更。',
    inputSchema: z.object({ force: z.boolean().optional(), recursive: z.boolean().optional() }),
    handler: async (args, ctx) => {
      try {
        const res = ensureMgr(ctx.cwd ?? process.cwd());
        if (!res) return err('未找到锚点。');
        return json(await res.m.sync(args.force));
      } catch (e) { return err(`${e}`); }
    },
  });

  reg({
    name: 'anchor_status',
    description: '返回锚点状态信息。',
    inputSchema: z.object({}),
    handler: async (_, ctx) => {
      try {
        const res = ensureMgr(ctx.cwd ?? process.cwd());
        if (!res) return err('未找到锚点。');
        const info = await res.m.status();
        let out = `📍 Anchor Status\n   路径: ${info.projectRoot}\n   文件: ${info.totalFiles}  向量: ${info.totalVectors}  维度: ${info.dimensions}\n   标签: ${info.tagCount}\n   模型: ${info.modelId}\n   指纹: ${info.fingerprint}\n   DB: ${sizeStr(info.dbSizeBytes)}  Index: ${sizeStr(info.indexSizeBytes)}`;
        if (info.migrationWarning) out += `\n\n${info.migrationWarning}`;
        return ok(out);
      } catch (e) { return err(`${e}`); }
    },
  });

  reg({
    name: 'anchor_config',
    description: '查看或修改检索参数。',
    inputSchema: z.object({ key: z.string().optional(), value: z.union([z.string(), z.number(), z.boolean()]).optional() }),
    handler: async (args, ctx) => {
      try {
        const anchor = resolveAnchor(ctx.cwd ?? process.cwd());
        if (!anchor) return err('未找到锚点。');
        const config = loadAnchorConfig(anchor.anchorDir);
        const ragParams = loadRagParams(anchor.anchorDir);
        if (!args.key) return json({ config, ragParams });
        return ok(`"${args.key}": ${JSON.stringify((config as any)[args.key] ?? (ragParams as any)[args.key])}`);
      } catch (e) { return err(`${e}`); }
    },
  });

  reg({
    name: 'anchor_tree',
    description: '返回当前锚点的层级树（父锚点、子锚点及状态）。',
    inputSchema: z.object({}),
    handler: async (_, ctx) => {
      try {
        const res = ensureMgr(ctx.cwd ?? process.cwd());
        if (!res) return err('未找到锚点。');
        await res.m.ensureLoaded();
        res.m.discoverHierarchy();
        const tree = res.m.anchorTree();

        // Format tree as text
        const formatNode = (node: any, indent: string = ''): string => {
          const basename = node.path.split(/[/\\]/).pop() || node.path;
          let line = `${indent}📌 ${basename} (${node.vectors} 向量, ${node.tags} 标签)`;
          for (const child of node.children) {
            line += '\n' + formatNode(child, indent + '   ');
          }
          return line;
        };
        return ok(`🌳 锚点层级树\n\n${formatNode(tree)}`);
      } catch (e) { return err(`${e}`); }
    },
  });

  reg({
    name: 'anchor_tag_inspect',
    description: '查看标签图谱状态；指定 tag 时返回关联标签和权重。',
    inputSchema: z.object({ tag: z.string().optional() }),
    handler: async (args, ctx) => {
      try {
        const res = ensureMgr(ctx.cwd ?? process.cwd());
        if (!res) return err('未找到锚点。');
        await res.m.ensureLoaded();
        const data = res.m.tagInspect(args.tag);
        return json(data);
      } catch (e) { return err(`${e}`); }
    },
  });
}
