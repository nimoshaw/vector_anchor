// src/index.ts
// Vector Anchor MCP Server — main entry point

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getAllTools, getTool, registerAllTools, setGlobalEmbedding, handleCallTool } from './tools.js';
import { logger, zodToJsonSchema } from './utils.js';

const VERSION = '0.1.0';

async function main() {
  logger.info('Server', `Vector Anchor v${VERSION} starting...`);

  // Load from env
  const apiKey = process.env.ANCHOR_API_KEY ?? '';
  const model = process.env.ANCHOR_MODEL ?? 'text-embedding-3-small';
  const baseUrl = process.env.ANCHOR_BASE_URL ?? '';
  if (apiKey) {
    setGlobalEmbedding(apiKey, model, baseUrl);
    logger.info('Server', `Embedding: ${model}${baseUrl ? ` @ ${baseUrl}` : ''}`);
  } else {
    logger.warn('Server', 'ANCHOR_API_KEY not set.');
  }

  registerAllTools();
  const tools = getAllTools();
  logger.info('Server', `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

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

  await server.connect(new StdioServerTransport());
  logger.info('Server', 'Running on stdio');
}

main().catch(e => { console.error(e); process.exit(1); });
