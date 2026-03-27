// src/utils.ts
// Unified utilities: config management, logger, and Zod-to-JSON converter

import { readFileSync, writeFileSync, existsSync, watchFile } from 'fs';
import { join, resolve, isAbsolute, dirname } from 'path';
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════
// Logger
// ═══════════════════════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel: LogLevel = 'info';
export function setLogLevel(level: LogLevel) { currentLevel = level; }

function log(level: LogLevel, module: string, message: string, data?: unknown) {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
  if (data !== undefined) {
    console.error(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (m: string, msg: string, d?: unknown) => log('debug', m, msg, d),
  info:  (m: string, msg: string, d?: unknown) => log('info',  m, msg, d),
  warn:  (m: string, msg: string, d?: unknown) => log('warn',  m, msg, d),
  error: (m: string, msg: string, d?: unknown) => log('error', m, msg, d),
};

// ═══════════════════════════════════════════════════════════════════════════
// Config types & defaults
// ═══════════════════════════════════════════════════════════════════════════

export interface EmbeddingConfig {
  provider?: string;
  model: string;
  api_key: string;
  base_url?: string;
  dimensions?: number;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  dimensions: number;
  base_url: string;
  probed_at: string;
}

export interface AnchorConfig {
  parent: string | null;
  children: string[];
  exclude_from_parent: boolean;
  ignore: string[];
  extensions: string[];
  chunk_strategy: 'auto' | 'fixed' | 'semantic';
  chunk_size: number;
  chunk_overlap: number;
  embedding_model: string | null;
  resolved_model?: ResolvedModel;
  model_migration?: {
    strategy: 'rebuild' | 'lazy' | 'warn';
    lazy_batch_size: number;
    auto_rebuild_threshold: number;
  };
  _fingerprint?: string;
  _dimensions?: number;
}

export interface RagParams {
  boost_beta_range: [number, number];
  residual_iterations: number;
  cooccurrence_hop: number;
  dedup_threshold: number;
  tag_recall_top_n: number;
  min_similarity: number;
}

export const DEFAULT_ANCHOR_CONFIG: AnchorConfig = {
  parent: null,
  children: [],
  exclude_from_parent: true,
  ignore: ['node_modules', '.git', 'dist', '*.lock', '.anchor'],
  extensions: ['.md', '.ts', '.js', '.py', '.txt', '.json', '.yaml', '.yml', '.tsx', '.jsx', '.rs', '.go', '.java', '.c', '.cpp', '.h'],
  chunk_strategy: 'auto',
  chunk_size: 512,
  chunk_overlap: 64,
  embedding_model: null,
  model_migration: { strategy: 'warn', lazy_batch_size: 100, auto_rebuild_threshold: 500 },
};

export const DEFAULT_RAG_PARAMS: RagParams = {
  boost_beta_range: [0.1, 0.5],
  residual_iterations: 2,
  cooccurrence_hop: 1,
  dedup_threshold: 0.90,
  tag_recall_top_n: 15,
  min_similarity: 0.25,
};

// ═══════════════════════════════════════════════════════════════════════════
// Config loading & saving
// ═══════════════════════════════════════════════════════════════════════════

function loadJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    // Try direct parse first (standard JSON has no comments)
    try { return JSON.parse(raw) as T; } catch { /* fall through */ }
    // Fallback: strip comments (only outside strings) for JSONC-like files
    const stripped = raw.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (match, str) => str ?? '');
    return JSON.parse(stripped) as T;
  } catch (err) {
    logger.warn('Config', `Failed to parse ${filePath}`, err);
    return null;
  }
}

export function loadAnchorConfig(anchorDir: string): AnchorConfig {
  const loaded = loadJsonFile<Partial<AnchorConfig>>(join(anchorDir, 'config.json'));
  return { ...DEFAULT_ANCHOR_CONFIG, ...loaded };
}

export function loadRagParams(anchorDir: string): RagParams {
  const loaded = loadJsonFile<Partial<RagParams>>(join(anchorDir, 'rag_params.json'));
  return { ...DEFAULT_RAG_PARAMS, ...loaded };
}

export function saveAnchorConfig(anchorDir: string, config: AnchorConfig): void {
  writeFileSync(join(anchorDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

export function saveRagParams(anchorDir: string, params: RagParams): void {
  writeFileSync(join(anchorDir, 'rag_params.json'), JSON.stringify(params, null, 2), 'utf-8');
}

export function watchConfigFile(filePath: string, onChange: () => void): void {
  if (!existsSync(filePath)) return;
  watchFile(filePath, { interval: 2000 }, () => {
    logger.info('Config', `Config file changed: ${filePath}`);
    onChange();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Zod → JSON Schema (for MCP tool registration)
// ═══════════════════════════════════════════════════════════════════════════

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Use Zod v4's built-in if available
  if ('toJsonSchema' in z && typeof (z as any).toJsonSchema === 'function') {
    try { return (z as any).toJsonSchema(schema); } catch {}
  }
  return manualConvert(schema);
}

function manualConvert(schema: z.ZodType): Record<string, unknown> {
  const desc = schema.description;
  const descProp = desc ? { description: desc } : {};

  try {
    if ('shape' in schema && typeof (schema as any).shape === 'object') {
      const shape = (schema as any).shape as Record<string, z.ZodType>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = manualConvert(value as z.ZodType);
        const isOpt = (value as any)?._zod?.optional === true || String(value?.constructor?.name).includes('Optional');
        if (!isOpt) required.push(key);
      }
      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), ...descProp };
    }
  } catch {}
  try { schema.parse('test'); return { type: 'string', ...descProp }; } catch {}
  try { schema.parse(0); return { type: 'number', ...descProp }; } catch {}
  try { schema.parse(true); return { type: 'boolean', ...descProp }; } catch {}
  return { type: 'object', ...descProp };
}

// ═══════════════════════════════════════════════════════════════════════════
// .env loader (shared across server + CLI)
// ═══════════════════════════════════════════════════════════════════════════

/** Load variables from a .env file into process.env (won't override existing vars) */
export function loadDotEnv(startDir?: string): void {
  try {
    // Walk up from startDir looking for .env
    let dir = resolve(startDir ?? process.cwd());
    let envPath = '';
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, '.env');
      if (existsSync(candidate)) { envPath = candidate; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!envPath) return;
    const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* no .env file, that's fine */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Path validation (prevents directory traversal)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate and normalize a user-supplied path.
 * Returns the resolved absolute path, or throws if it looks malicious.
 */
export function validatePath(userPath: string): string {
  const resolved = resolve(userPath);
  // Block obvious traversal patterns in the raw input
  if (userPath.includes('..') && !isAbsolute(userPath)) {
    throw new Error(`Path rejected: relative traversal not allowed ("${userPath}")`);
  }
  return resolved;
}
