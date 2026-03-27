#!/usr/bin/env node
// src/cli.ts
// Vector Anchor CLI — 通过 HTTP 调用已运行的 MCP 服务

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './utils.js';

// Load .env for ANCHOR_PORT
loadDotEnv();

function getPort(): number {
  return parseInt(process.env.ANCHOR_PORT ?? '23517', 10);
}

const BASE = `http://127.0.0.1:${getPort()}`;

// ─── MCP JSON-RPC 调用 ──────────────────────────────────────────────────────
let sessionId: string | undefined;
let reqId = 0;

async function mcpCall(method: string, params?: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id: ++reqId });
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body });

  // 保存 session id
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const text = await res.text();

  // 处理 SSE 格式 (text/event-stream)
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
      }
    }
  }

  // 普通 JSON
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─── 命令定义 ────────────────────────────────────────────────────────────────
interface Command {
  description: string;
  usage: string;
  run: (args: string[]) => Promise<void>;
}

const commands: Record<string, Command> = {
  init: {
    description: '初始化向量锚点（全量扫描与索引构建）',
    usage: 'anchor init <目录路径> [--force]',
    run: async (args) => {
      const path = args[0] || process.cwd();
      const force = args.includes('--force');
      await callTool('anchor_init', { path, options: force ? { force: true } : undefined });
    },
  },
  search: {
    description: '语义搜索锚点索引',
    usage: 'anchor search <查询> [--top <N>]',
    run: async (args) => {
      let top_k: number | undefined;
      const queryParts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--top' && args[i + 1]) { top_k = parseInt(args[++i], 10); }
        else { queryParts.push(args[i]); }
      }
      const query = queryParts.join(' ');
      if (!query) { console.error('用法: anchor search <查询>'); process.exit(1); }
      await callTool('anchor_search', { query, top_k });
    },
  },
  sync: {
    description: '增量同步文件变更',
    usage: 'anchor sync [--force]',
    run: async (args) => {
      await callTool('anchor_sync', { force: args.includes('--force') });
    },
  },
  status: {
    description: '查看锚点状态',
    usage: 'anchor status',
    run: async () => { await callTool('anchor_status', {}); },
  },
  config: {
    description: '查看或修改检索参数',
    usage: 'anchor config [key] [value]',
    run: async (args) => {
      const params: Record<string, unknown> = {};
      if (args[0]) params.key = args[0];
      if (args[1]) params.value = isNaN(Number(args[1])) ? args[1] : Number(args[1]);
      await callTool('anchor_config', params);
    },
  },
  tree: {
    description: '查看锚点层级树',
    usage: 'anchor tree',
    run: async () => { await callTool('anchor_tree', {}); },
  },
  tags: {
    description: '查看标签图谱',
    usage: 'anchor tags [tag名]',
    run: async (args) => {
      await callTool('anchor_tag_inspect', args[0] ? { tag: args[0] } : {});
    },
  },
};

// ─── 工具调用封装 ────────────────────────────────────────────────────────────
async function callTool(name: string, args: Record<string, unknown>) {
  // 先初始化 session
  const initRes = await mcpCall('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'anchor-cli', version: '0.1.0' },
  });

  if (initRes?.error) {
    console.error('请确认服务已启动: npm run serve');
    process.exit(1);
  }

  // 调用工具
  const result = await mcpCall('tools/call', { name, arguments: args });

  if (result?.error) {
    console.error('错误:', result.error.message ?? JSON.stringify(result.error));
    process.exit(1);
  }

  const content = result?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') console.log(item.text);
    }
    if (result.result.isError) process.exit(1);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// ─── 健康检查 + 自动拉起 ──────────────────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`);
    return res.ok;
  } catch { return false; }
}

/** Auto-start server in background, wait up to 5s for it to come up */
async function autoStartServer(): Promise<boolean> {
  console.log('⚡ 服务未运行，正在自动启动...');
  // Resolve project root (where server.ts lives)
  const thisDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(thisDir, '..');

  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();

  // Poll /health for up to 5 seconds
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkHealth()) {
      console.log('✅ 服务已自动启动');
      return true;
    }
  }
  return false;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Vector Anchor CLI\n');
    console.log('用法: anchor <命令> [参数]\n');
    console.log('命令:');
    for (const [name, def] of Object.entries(commands)) {
      console.log(`  ${name.padEnd(10)} ${def.description}`);
    }
    console.log(`\n示例:`);
    console.log(`  anchor init .              初始化当前目录`);
    console.log(`  anchor search "用户登录"   搜索相关代码`);
    console.log(`  anchor status              查看索引状态`);
    process.exit(0);
  }

  if (cmd === 'health') {
    const ok = await checkHealth();
    console.log(ok ? '✅ 服务运行中' : '❌ 服务未启动');
    process.exit(ok ? 0 : 1);
  }

  const command = commands[cmd];
  if (!command) {
    console.error(`未知命令: ${cmd}\n运行 anchor --help 查看可用命令`);
    process.exit(1);
  }

  // 检查服务状态 — 未启动则自动拉起
  if (!(await checkHealth())) {
    if (!(await autoStartServer())) {
      console.error('❌ 服务启动超时。请手动运行: npm run serve');
      process.exit(1);
    }
  }

  await command.run(args.slice(1));
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });

