// src/model.ts
// Model management: 3-layer config detection + sentinel fingerprint + migration

import { createHash } from 'crypto';
import { logger } from './utils.js';
import type { EmbeddingConfig, ResolvedModel } from './utils.js';
import { embed, vectorToBuffer, type EmbedOptions } from './embedding.js';

// ═══════════════════════════════════════════════════════════════════════════
// Known model registry (Layer 1)
// ═══════════════════════════════════════════════════════════════════════════

interface ModelInfo { provider: string; dimensions: number; base_url: string; }

const KNOWN_MODELS: Record<string, ModelInfo> = {
  'text-embedding-3-small':  { provider: 'openai', dimensions: 1536, base_url: 'https://api.openai.com/v1' },
  'text-embedding-3-large':  { provider: 'openai', dimensions: 3072, base_url: 'https://api.openai.com/v1' },
  'text-embedding-ada-002':  { provider: 'openai', dimensions: 1536, base_url: 'https://api.openai.com/v1' },
  'models/text-embedding-004': { provider: 'google', dimensions: 768, base_url: 'https://generativelanguage.googleapis.com/v1beta' },
  'nomic-embed-text':  { provider: 'ollama', dimensions: 768,  base_url: 'http://localhost:11434' },
  'mxbai-embed-large': { provider: 'ollama', dimensions: 1024, base_url: 'http://localhost:11434' },
  'bge-m3':            { provider: 'ollama', dimensions: 1024, base_url: 'http://localhost:11434' },
  'all-minilm':        { provider: 'ollama', dimensions: 384,  base_url: 'http://localhost:11434' },
  // Qwen3 Embedding series (OpenAI-compatible API)
  'Qwen/Qwen3-Embedding-0.6B': { provider: 'custom', dimensions: 1024, base_url: 'http://localhost:3000/v1' },
  'Qwen/Qwen3-Embedding-4B':   { provider: 'custom', dimensions: 2560, base_url: 'http://localhost:3000/v1' },
  'Qwen/Qwen3-Embedding-8B':   { provider: 'custom', dimensions: 4096, base_url: 'http://localhost:3000/v1' },
};

// ─── Provider inference (Layer 2/3 helper) ─────────────────────────────────

function inferProvider(model: string, baseUrl?: string): string {
  if (baseUrl) {
    if (baseUrl.includes('openai.com')) return 'openai';
    if (baseUrl.includes('localhost:11434') || baseUrl.includes('ollama')) return 'ollama';
    if (baseUrl.includes('googleapis.com')) return 'google';
    return 'custom';
  }
  if (model.startsWith('text-embedding')) return 'openai';
  if (model.startsWith('models/')) return 'google';
  return 'ollama';
}

function inferBaseUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    ollama: 'http://localhost:11434',
    google: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return urls[provider] ?? '';
}

// ═══════════════════════════════════════════════════════════════════════════
// 3-layer model resolution
// ═══════════════════════════════════════════════════════════════════════════

export async function resolveModelConfig(
  userConfig: EmbeddingConfig,
  probeFn?: (text: string) => Promise<number[]>,
): Promise<{ resolved: ResolvedModel; source: 'registry' | 'probe' | 'manual' }> {
  const model = userConfig.model;

  // Layer 1: Registry
  const reg = KNOWN_MODELS[model];
  if (reg) {
    logger.info('Model', `Layer 1 hit: ${model} → dim=${reg.dimensions}`);
    return {
      resolved: {
        provider: userConfig.provider ?? reg.provider,
        model,
        dimensions: userConfig.dimensions ?? reg.dimensions,
        base_url: userConfig.base_url ?? reg.base_url,
        probed_at: new Date().toISOString(),
      },
      source: 'registry',
    };
  }

  // Layer 2: Probe
  if (probeFn) {
    try {
      logger.info('Model', `Layer 2: Probing "${model}"...`);
      const vec = await probeFn('hello');
      const provider = userConfig.provider ?? inferProvider(model, userConfig.base_url);
      return {
        resolved: { provider, model, dimensions: vec.length, base_url: userConfig.base_url ?? inferBaseUrl(provider), probed_at: new Date().toISOString() },
        source: 'probe',
      };
    } catch (err) {
      logger.warn('Model', `Probe failed for "${model}"`, err);
    }
  }

  // Layer 3: Manual
  if (userConfig.dimensions) {
    const provider = userConfig.provider ?? inferProvider(model, userConfig.base_url);
    return {
      resolved: { provider, model, dimensions: userConfig.dimensions, base_url: userConfig.base_url ?? inferBaseUrl(provider), probed_at: new Date().toISOString() },
      source: 'manual',
    };
  }

  throw new Error(`Cannot determine dimensions for "${model}". Set "dimensions" in embedding config.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Sentinel fingerprint
// ═══════════════════════════════════════════════════════════════════════════

const SENTINEL = 'The quick brown fox jumps over the lazy dog. Vector Anchor sentinel v1.';
export type MigrationStrategy = 'rebuild' | 'lazy' | 'warn';

export interface FingerprintResult { fingerprint: string; dimensions: number; }

export async function generateFingerprint(opts: EmbedOptions): Promise<FingerprintResult> {
  const vectors = await embed([SENTINEL], opts);
  const buf = vectorToBuffer(vectors[0]);
  const fingerprint = createHash('sha256').update(buf).digest('hex');
  logger.info('Fingerprint', `Generated: ${fingerprint.slice(0, 16)}... (dim=${vectors[0].length})`);
  return { fingerprint, dimensions: vectors[0].length };
}

export async function checkFingerprint(
  opts: EmbedOptions,
  storedFp: string | null,
  storedDim: number | null,
): Promise<{ matches: boolean; current: FingerprintResult; dimensionsChanged: boolean }> {
  const current = await generateFingerprint(opts);
  if (!storedFp) return { matches: true, current, dimensionsChanged: false };
  return {
    matches: current.fingerprint === storedFp,
    current,
    dimensionsChanged: storedDim !== null && current.dimensions !== storedDim,
  };
}

export function executeMigration(
  check: { matches: boolean; dimensionsChanged: boolean },
  strategy: MigrationStrategy,
): { action: 'none' | 'rebuild' | 'warn'; message: string } {
  if (check.matches) return { action: 'none', message: '模型指纹匹配。' };
  if (check.dimensionsChanged) return { action: 'rebuild', message: '⚠️ 模型维度变化，必须全量重建索引。' };

  switch (strategy) {
    case 'rebuild': return { action: 'rebuild', message: '🔄 模型切换，策略: rebuild，将全量重建。' };
    case 'warn': return { action: 'warn', message: '⚠️ 模型切换，搜索可能不准确。建议 anchor_sync --force 重建。' };
    case 'lazy': return { action: 'warn', message: '⚠️ 模型切换 (lazy 暂未实现，行为同 warn)。' };
  }
}
