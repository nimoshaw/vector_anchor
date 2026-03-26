// src/server.ts
// Vector Anchor MCP Server — HTTP (Streamable HTTP) entry point
// Runs as a persistent background service; Antigravity connects via URL.

// Polyfill: inject global `require` for CJS native addons (anchor-core)
import { createRequire } from 'node:module';
if (typeof globalThis.require === 'undefined') {
  (globalThis as any).require = createRequire(import.meta.url);
}

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { getAllTools, getTool, registerAllTools, setGlobalEmbedding } from './tools.js';
import type { ToolContext } from './tools.js';
import { logger, zodToJsonSchema } from './utils.js';

const VERSION = '0.1.0';

// ─── Load .env (lightweight, no dependency) ─────────────────────────────────
function loadDotEnv() {
  try {
    const envPath = resolve(import.meta.dirname ?? process.cwd(), '..', '.env');
    const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* no .env file, that's fine */ }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
async function main() {
  loadDotEnv();

  const PORT = parseInt(process.env.ANCHOR_PORT ?? '23517', 10);
  const apiKey = process.env.ANCHOR_API_KEY ?? '';
  const model = process.env.ANCHOR_MODEL ?? 'text-embedding-3-small';
  const baseUrl = process.env.ANCHOR_BASE_URL ?? '';

  logger.info('Server', `Vector Anchor v${VERSION} starting (HTTP mode)...`);

  // ── Initialize tools ONCE at startup ──────────────────────────────────
  if (apiKey) {
    setGlobalEmbedding(apiKey, model, baseUrl);
    logger.info('Server', `Embedding: ${model}${baseUrl ? ` @ ${baseUrl}` : ''}`);
  } else {
    logger.warn('Server', 'ANCHOR_API_KEY not set.');
  }

  registerAllTools();
  const tools = getAllTools();
  logger.info('Server', `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  // ── Shared request handlers (closures over tools) ─────────────────────
  function handleListTools() {
    return {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    };
  }

  async function handleCallTool(name: string, args: Record<string, unknown> | undefined) {
    const tool = getTool(name);
    if (!tool) return { content: [{ type: 'text' as const, text: `Unknown: ${name}` }], isError: true };

    try {
      const parsed = tool.inputSchema.parse(args ?? {});
      const ctx: ToolContext = {
        cwd: typeof args === 'object' && args !== null && 'path' in args
          ? String(args.path) : process.cwd(),
      };
      const result = await tool.handler(parsed, ctx);
      return { content: result.content, isError: result.isError };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  }

  // ── Create a new MCP Server instance (light — reuses shared tools) ────
  function createServer(): Server {
    const server = new Server(
      { name: 'vector-anchor', version: VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => handleListTools());
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return handleCallTool(name, args);
    });
    return server;
  }

  const app = createMcpExpressApp();

  // ── Auth middleware ──────────────────────────────────────────────────────
  const SECRET = process.env.ANCHOR_SECRET;
  if (SECRET) {
    app.use((req, res, next) => {
      // Allow health check without auth
      if (req.path === '/health') return next();
      // Allow localhost without auth
      const ip = req.ip ?? req.socket.remoteAddress ?? '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
      // Require Bearer token for LAN clients
      const auth = req.headers.authorization;
      if (auth === `Bearer ${SECRET}`) return next();
      res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>' });
    });
    logger.info('Server', 'Auth enabled — LAN clients need Bearer token');
  }

  // Store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

  // ── Streamable HTTP endpoint ────────────────────────────────────────────
  app.all('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existing = transports[sessionId];
        if (existing instanceof StreamableHTTPServerTransport) {
          transport = existing;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session uses a different transport' },
            id: null,
          });
          return;
        }
      } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            logger.info('HTTP', `Session initialized: ${sid.slice(0, 8)}...`);
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info('HTTP', `Session closed: ${sid.slice(0, 8)}...`);
            delete transports[sid];
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('HTTP', `Error: ${error}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ── Legacy SSE endpoint (backwards compat) ──────────────────────────────
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => { delete transports[transport.sessionId]; });
    const server = createServer();
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport instanceof SSEServerTransport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });

  // ── Health check ────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION, uptime: process.uptime() });
  });

  // ── Start ───────────────────────────────────────────────────────────────
  const HOST = process.env.ANCHOR_HOST ?? '0.0.0.0';
  app.listen(PORT, HOST, () => {
    logger.info('Server', `HTTP listening on http://${HOST}:${PORT}/mcp`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Server', 'Shutting down...');
    for (const sid in transports) {
      try { await transports[sid].close(); } catch { /* ignore */ }
      delete transports[sid];
    }
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
