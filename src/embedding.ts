// src/embedding.ts
// Embedding API abstraction: OpenAI, Ollama, Google, custom (OpenAI-compatible)
// Includes LRU cache for query-time embedding reuse.

import { logger } from './utils.js';
import type { ResolvedModel } from './utils.js';

export interface EmbedOptions {
  apiKey: string;
  resolved: ResolvedModel;
}

// ─── LRU Cache ──────────────────────────────────────────────────────────────

const CACHE_MAX = 256;
const cache = new Map<string, { vec: number[] }>();

function cacheKey(text: string, model: string): string {
  return `${model}::${text}`;
}

function cacheGet(text: string, model: string): number[] | undefined {
  const key = cacheKey(text, model);
  const entry = cache.get(key);
  if (!entry) return undefined;
  // LRU: move to end
  cache.delete(key);
  cache.set(key, entry);
  return entry.vec;
}

function cachePut(text: string, model: string, vec: number[]): void {
  const key = cacheKey(text, model);
  if (cache.size >= CACHE_MAX) {
    // Evict oldest (first entry)
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { vec });
}

/** Cache stats for monitoring */
export function embedCacheStats() {
  return { size: cache.size, maxSize: CACHE_MAX };
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Embed one or more texts. Auto-dispatches to correct provider.
 * Single-text requests hit cache first (search queries).
 */
export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const model = opts.resolved.model;

  // Single text: use cache (typical for search queries)
  if (texts.length === 1) {
    const cached = cacheGet(texts[0], model);
    if (cached) {
      logger.debug('Embed', `Cache hit: "${texts[0].slice(0, 40)}..."`);
      return [cached];
    }
  }

  // Call API
  let results: number[][];
  switch (opts.resolved.provider) {
    case 'openai':  results = await embedOpenAI(texts, opts); break;
    case 'ollama':  results = await embedOllama(texts, opts); break;
    case 'google':  results = await embedGoogle(texts, opts); break;
    default:        results = await embedOpenAI(texts, opts); break;
  }

  // Cache results for small batches (≤8 texts, avoid caching bulk indexing)
  if (texts.length <= 8) {
    for (let i = 0; i < texts.length; i++) {
      cachePut(texts[i], model, results[i]);
    }
  }

  return results;
}

export async function embedSingle(text: string, opts: EmbedOptions): Promise<number[]> {
  return (await embed([text], opts))[0];
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

async function embedOpenAI(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const url = `${opts.resolved.base_url}/embeddings`;
  logger.debug('Embed', `OpenAI: ${texts.length} texts → ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model: opts.resolved.model, input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map(d => d.embedding);
}

// ─── Ollama ────────────────────────────────────────────────────────────────

async function embedOllama(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const url = `${opts.resolved.base_url}/api/embed`;
  logger.debug('Embed', `Ollama: ${texts.length} texts → ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.resolved.model, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

// ─── Google ────────────────────────────────────────────────────────────────

async function embedGoogle(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const url = `${opts.resolved.base_url}/${opts.resolved.model}:batchEmbedContents`;
  const requests = texts.map(text => ({ model: opts.resolved.model, content: { parts: [{ text }] } }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Google embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map(e => e.values);
}

// ─── Buffer conversion ────────────────────────────────────────────────────

export function vectorToBuffer(vector: number[]): Buffer {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}
