// src/server.ts
// Vector Anchor MCP Server — HTTP (Streamable HTTP) entry point
// Runs as a persistent background service; Antigravity connects via URL.

// Polyfill: inject global `require` for CJS native addons (anchor-core)
import { createRequire } from 'node:module';
if (typeof globalThis.require === 'undefined') {
  (globalThis as any).require = createRequire(import.meta.url);
}

import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { getAllTools, registerAllTools, setGlobalEmbedding, handleCallTool } from './tools.js';
import { logger, zodToJsonSchema, loadDotEnv } from './utils.js';

const VERSION = '0.1.0';

async function main() {
  loadDotEnv(import.meta.dirname ?? process.cwd());

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

  function createServer(): Server {
    const server = new Server(
      { name: 'vector-anchor', version: VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await handleCallTool(name, args);
      return { ...result };
    });
    return server;
  }

  const HOST = process.env.ANCHOR_HOST ?? '0.0.0.0';
  const app = createMcpExpressApp({ host: HOST });

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
      const auth = req.headers.authorization ?? '';
      const expected = `Bearer ${SECRET}`;
      const authBuf = Buffer.from(auth);
      const expBuf = Buffer.from(expected);
      if (authBuf.length === expBuf.length && timingSafeEqual(authBuf, expBuf)) return next();
      res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>' });
    });
    logger.info('Server', 'Auth enabled — LAN clients need Bearer token');
  }

  // Store transports by session ID with creation time for cleanup
  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};
  const sessionCreatedAt: Record<string, number> = {};
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // Periodic session cleanup (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const sid in sessionCreatedAt) {
      if (now - sessionCreatedAt[sid] > SESSION_TTL_MS) {
        try { transports[sid]?.close(); } catch { /* ignore */ }
        delete transports[sid];
        delete sessionCreatedAt[sid];
        logger.info('HTTP', `Session expired: ${sid.slice(0, 8)}...`);
      }
    }
  }, 5 * 60 * 1000);

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
            sessionCreatedAt[sid] = Date.now();
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info('HTTP', `Session closed: ${sid.slice(0, 8)}...`);
            delete transports[sid];
            delete sessionCreatedAt[sid];
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
    sessionCreatedAt[transport.sessionId] = Date.now();
    res.on('close', () => {
      delete transports[transport.sessionId];
      delete sessionCreatedAt[transport.sessionId];
    });
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

  app.listen(PORT, HOST, () => {
    logger.info('Server', `HTTP listening on http://${HOST}:${PORT}/mcp`);
    autoRegisterMcpConfig(PORT);
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

// ═══════════════════════════════════════════════════════════════════════════
// Auto-register MCP config for Antigravity discovery
// ═══════════════════════════════════════════════════════════════════════════

function autoRegisterMcpConfig(port: number): void {
  try {
    const configDir = join(homedir(), '.gemini', 'antigravity');
    const configPath = join(configDir, 'mcp_config.json');
    const expectedUrl = `http://127.0.0.1:${port}/mcp`;

    // Read existing config or start fresh
    let config: any = { mcpServers: {} };
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8').trim();
        if (raw) config = JSON.parse(raw);
      } catch { /* corrupt file, overwrite */ }
    }
    if (!config.mcpServers) config.mcpServers = {};

    // Check if already registered with correct URL
    const existing = config.mcpServers['vector-anchor'];
    if (existing?.url === expectedUrl) {
      logger.info('Server', `MCP config OK: ${configPath}`);
      return;
    }

    // Register / update
    config.mcpServers['vector-anchor'] = { url: expectedUrl };

    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.info('Server', `MCP config registered: ${configPath}`);
  } catch (err) {
    logger.warn('Server', 'MCP auto-register failed (non-fatal)', err);
  }
}
