// src/pipeline.ts
// 3-Stage Intelligent Retrieval Pipeline: Sensing → Boost → Retrieve
//
// This module implements the core search enhancement algorithm inspired by VCP TagMemo,
// simplified for directory-level search (3 stages vs VCP's 7 stages).

import { AnchorIndex, type SvdResult } from 'anchor-core';
import { embed, embedSingle, vectorToBuffer, type EmbedOptions } from './embedding.js';
import { loadRagParams, type RagParams, logger } from './utils.js';

const MODULE = 'Pipeline';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** A single search result with full metadata */
export interface PipelineResult {
  id: number;
  content: string;
  filePath: string;
  heading: string;
  startLine: number;
  endLine: number;
  similarity: number;
  /** Tags that contributed to this result's boost */
  matchedTags?: string[];
  /** Whether this result was found via residual compensation */
  isResidualFind?: boolean;
}

/** Internal tag representation for the boost stage */
interface TagEntry {
  id: number;
  name: string;
  vector: Float32Array;
  vectorBuf: Buffer;
  weight: number;
}

/** Chunk metadata stored in chunk_meta.json */
interface ChunkMeta {
  content: string;
  filePath: string;
  heading: string;
  startLine: number;
  endLine: number;
  tags?: string[];
}

/** Pipeline configuration (subset of RagParams + search options) */
export interface PipelineConfig {
  topK: number;
  minSimilarity: number;
  maxBoostTags: number;
  boostBeta: [number, number];
  residualIterations: number;
  cooccurrenceHop: number;
  dedupThreshold: number;
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  topK: 10,
  minSimilarity: 0.25,
  maxBoostTags: 15,
  boostBeta: [0.1, 0.5],
  residualIterations: 2,
  cooccurrenceHop: 1,
  dedupThreshold: 0.90,
};

// ═══════════════════════════════════════════════════════════════════════════
// TF-IDF Tag Extraction (lightweight, no LLM dependency)
// ═══════════════════════════════════════════════════════════════════════════

// Common stop words for tag extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'because', 'as', 'until', 'while', 'of',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  // Code-specific noise
  'const', 'let', 'var', 'function', 'return', 'import', 'export',
  'class', 'interface', 'type', 'string', 'number', 'boolean', 'null',
  'undefined', 'true', 'false', 'new', 'if', 'else', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'try', 'catch', 'throw',
  'async', 'await', 'void', 'public', 'private', 'protected', 'static',
  // Chinese stop words
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
]);

/** Tokenize text into candidate terms (handles CJK + Latin) */
export function tokenize(text: string): string[] {
  // Split on non-word boundaries, keep CJK characters and Latin words
  const tokens: string[] = [];

  // Latin words (2+ chars, no pure numbers)
  const latinMatches = text.match(/[a-zA-Z_][a-zA-Z0-9_]{1,}/g) ?? [];
  for (const m of latinMatches) {
    const lower = m.toLowerCase();
    if (!STOP_WORDS.has(lower) && lower.length >= 2) {
      // Split camelCase: "getUserName" → ["get", "user", "name"]
      const parts = lower.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/);
      for (const p of parts) {
        if (p.length >= 2 && !STOP_WORDS.has(p)) tokens.push(p);
      }
    }
  }

  // CJK bigrams (2-char windows for Chinese/Japanese/Korean)
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}/g) ?? [];
  for (const segment of cjkChars) {
    for (let i = 0; i < segment.length - 1; i++) {
      const bigram = segment.slice(i, i + 2);
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
    }
    // Also add the full segment if it's short enough to be a term
    if (segment.length <= 4 && !STOP_WORDS.has(segment)) {
      tokens.push(segment);
    }
  }

  return tokens;
}

/** Extract top-N tags from a collection of chunks using TF-IDF scoring */
export function extractTags(
  chunks: Array<{ content: string; filePath: string }>,
  maxTags: number = 50,
): Array<{ name: string; score: number }> {
  // Document frequency: how many chunks contain each term
  const df = new Map<string, number>();
  // Term frequency per chunk
  const chunkTerms: Array<Map<string, number>> = [];

  for (const chunk of chunks) {
    const terms = tokenize(chunk.content);
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    chunkTerms.push(tf);

    // Update DF
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // Compute TF-IDF scores (aggregate across all chunks)
  const N = chunks.length;
  const scores = new Map<string, number>();

  for (const tf of chunkTerms) {
    for (const [term, count] of tf) {
      const termDf = df.get(term) ?? 1;
      const idf = Math.log(1 + N / termDf);
      const tfidf = count * idf;
      scores.set(term, (scores.get(term) ?? 0) + tfidf);
    }
  }

  // Sort and return top-N
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([name, score]) => ({ name, score }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Graph (in-memory representation loaded from SQLite or chunk_meta)
// ═══════════════════════════════════════════════════════════════════════════

export class TagGraph {
  private tags: Map<string, TagEntry> = new Map();
  private cooccurrence: Map<string, Map<string, number>> = new Map();
  private dirty = false;

  get size() { return this.tags.size; }
  get isDirty() { return this.dirty; }

  /** Add or update a tag with its embedding vector */
  setTag(name: string, vector: number[], weight: number = 1.0): void {
    const existing = this.tags.get(name);
    const id = existing?.id ?? this.tags.size + 1;
    // Pre-encode as Float32Array + Buffer for zero-allocation search
    const f32 = new Float32Array(vector);
    const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    this.tags.set(name, { id, name, vector: f32, vectorBuf: buf, weight });
    this.dirty = true;
  }

  /** Record cooccurrence between two tags */
  addCooccurrence(tagA: string, tagB: string, weight: number = 1.0): void {
    if (tagA === tagB) return;
    const [a, b] = tagA < tagB ? [tagA, tagB] : [tagB, tagA]; // canonical order
    if (!this.cooccurrence.has(a)) this.cooccurrence.set(a, new Map());
    const current = this.cooccurrence.get(a)!.get(b) ?? 0;
    this.cooccurrence.get(a)!.set(b, current + weight);
    this.dirty = true;
  }

  /** Get tag entry by name */
  getTag(name: string): TagEntry | undefined { return this.tags.get(name); }

  /** Get all tags as array */
  allTags(): TagEntry[] { return Array.from(this.tags.values()); }

  /** Get top-N tags most similar to a query vector (via Rust cosine similarity) */
  getTopTags(
    queryVector: number[],
    index: InstanceType<typeof AnchorIndex>,
    topN: number,
  ): Array<{ tag: TagEntry; similarity: number }> {
    const qBuf = vectorToBuffer(queryVector);
    const results: Array<{ tag: TagEntry; similarity: number }> = [];

    for (const tag of this.tags.values()) {
      if (tag.vector.length !== queryVector.length) continue;
      // Use pre-encoded Buffer — zero allocation per tag
      const sim = index.cosineSimilarity(qBuf, tag.vectorBuf);
      if (sim > 0.1) results.push({ tag, similarity: sim });
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topN);
  }

  /** Get 1-hop cooccurring tags for a set of seed tags */
  expand1Hop(seedTags: string[], topN: number, minWeight: number = 0.1): Array<{ name: string; weight: number }> {
    const seedSet = new Set(seedTags);
    const candidates = new Map<string, number>();

    for (const [a, neighbors] of this.cooccurrence) {
      for (const [b, w] of neighbors) {
        if (w < minWeight) continue;
        if (seedSet.has(a) && !seedSet.has(b)) {
          candidates.set(b, Math.max(candidates.get(b) ?? 0, w));
        }
        if (seedSet.has(b) && !seedSet.has(a)) {
          candidates.set(a, Math.max(candidates.get(a) ?? 0, w));
        }
      }
    }

    return Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name, weight]) => ({ name, weight }));
  }

  /** Build cooccurrence from chunk tag assignments */
  buildCooccurrence(chunkTags: string[][]): void {
    for (const tags of chunkTags) {
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          this.addCooccurrence(tags[i], tags[j]);
        }
      }
    }
  }

  /** Serialize to JSON for persistence */
  toJSON(): {
    tags: Array<{ name: string; vector: number[]; weight: number }>;
    cooccurrence: Array<{ a: string; b: string; weight: number }>;
  } {
    const tags = Array.from(this.tags.values()).map(t => ({
      name: t.name, vector: Array.from(t.vector), weight: t.weight,
    }));

    const cooccurrence: Array<{ a: string; b: string; weight: number }> = [];
    for (const [a, neighbors] of this.cooccurrence) {
      for (const [b, w] of neighbors) {
        cooccurrence.push({ a, b, weight: w });
      }
    }

    return { tags, cooccurrence };
  }

  /** Load from JSON */
  static fromJSON(data: ReturnType<TagGraph['toJSON']>): TagGraph {
    const graph = new TagGraph();
    for (const t of data.tags) {
      graph.setTag(t.name, t.vector, t.weight);
    }
    for (const c of data.cooccurrence) {
      graph.addCooccurrence(c.a, c.b, c.weight);
    }
    graph.dirty = false;
    return graph;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3-Stage Pipeline
// ═══════════════════════════════════════════════════════════════════════════

export class SearchPipeline {
  private index: InstanceType<typeof AnchorIndex>;
  private embedOpts: EmbedOptions;
  private tagGraph: TagGraph;
  private meta: Record<number, ChunkMeta>;
  private config: PipelineConfig;
  /** Cached SVD basis to avoid recomputation across searches */
  private svdBasis: { u: Buffer; k: number; meanVec: Buffer } | null = null;

  constructor(
    index: InstanceType<typeof AnchorIndex>,
    embedOpts: EmbedOptions,
    tagGraph: TagGraph,
    meta: Record<number, ChunkMeta>,
    config?: Partial<PipelineConfig>,
  ) {
    this.index = index;
    this.embedOpts = embedOpts;
    this.tagGraph = tagGraph;
    this.meta = meta;
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
  }

  /** Main entry: execute the full 3-stage pipeline */
  async search(query: string): Promise<PipelineResult[]> {
    const { results } = await this.searchWithMeta(query);
    return results;
  }

  /** Extended search that also exposes pipeline metadata for context folding */
  async searchWithMeta(query: string): Promise<{
    results: PipelineResult[];
    meta: { logicDepth: number; mode: 'precise' | 'explore'; matchedTags: string[]; elapsedMs: number };
  }> {
    const t0 = Date.now();

    // ── Stage 1: Sensing ──
    const sensing = await this.sensing(query);
    logger.debug(MODULE, `Sensing: logicDepth=${sensing.logicDepth.toFixed(2)}, mode=${sensing.mode}`);

    // ── Stage 2: Boost (only if tags available) ──
    let boostedVector = sensing.queryVector;
    let matchedTags: string[] = [];

    if (this.tagGraph.size > 0) {
      const boost = this.boost(sensing.queryVector, sensing.logicDepth);
      boostedVector = boost.boostedVector;
      matchedTags = boost.matchedTags;
      logger.debug(MODULE, `Boost: ${matchedTags.length} tags, beta=${boost.beta.toFixed(3)}`);
    }

    // ── Stage 3: Retrieve + Dedup ──
    const results = this.retrieve(boostedVector, sensing.queryVector, matchedTags);

    const elapsed = Date.now() - t0;
    logger.info(MODULE, `Pipeline: ${results.length} results in ${elapsed}ms (tags=${matchedTags.length})`);

    return {
      results,
      meta: { logicDepth: sensing.logicDepth, mode: sensing.mode, matchedTags, elapsedMs: elapsed },
    };
  }

  // ─── Stage 1: Sensing ────────────────────────────────────────────────

  private async sensing(query: string): Promise<{
    cleanQuery: string;
    queryVector: number[];
    logicDepth: number;
    mode: 'precise' | 'explore';
  }> {
    // 1. Text cleanup: strip code fences, special chars, normalize whitespace
    const cleanQuery = query
      .replace(/```[\s\S]*?```/g, '')       // remove code blocks
      .replace(/`[^`]+`/g, match => match.slice(1, -1)) // unwrap inline code
      .replace(/[#*_~>|]/g, '')             // strip markdown formatting
      .replace(/\s+/g, ' ')                 // normalize whitespace
      .trim();

    // 2. Get query embedding
    const queryVector = await embedSingle(cleanQuery || query, this.embedOpts);

    // 3. Logic depth via EPA (use cached SVD basis)
    let logicDepth = 0.5; // default: moderate
    const stats = this.index.stats();

    if (stats.totalVectors >= 10) {
      try {
        // Build SVD basis once, cache for future searches
        if (!this.svdBasis) {
          const sampleVectors = await this.getSampleVectors(Math.min(30, stats.totalVectors));
          if (sampleVectors.length > 0) {
            const dim = this.embedOpts.resolved.dimensions;
            const flatVectors = new Float32Array(sampleVectors.length * dim);
            for (let i = 0; i < sampleVectors.length; i++) {
              for (let j = 0; j < dim; j++) {
                flatVectors[i * dim + j] = sampleVectors[i][j];
              }
            }
            const svd = this.index.computeSvd(
              Buffer.from(flatVectors.buffer),
              sampleVectors.length,
              Math.min(10, sampleVectors.length),
            );
            if (svd.k > 0) {
              this.svdBasis = {
                u: Buffer.from(new Float32Array(svd.u).buffer),
                k: svd.k,
                meanVec: Buffer.from(new Float32Array(dim).buffer),
              };
            }
          }
        }

        if (this.svdBasis) {
          const epa = this.index.project(
            vectorToBuffer(queryVector),
            this.svdBasis.u,
            this.svdBasis.meanVec,
            this.svdBasis.k,
          );
          const maxEntropy = Math.log(this.svdBasis.k);
          logicDepth = maxEntropy > 0 ? epa.entropy / maxEntropy : 0.5;
        }
      } catch (err) {
        logger.debug(MODULE, 'EPA fallback to default logic depth', err);
      }
    }

    // Classify search mode
    const mode = logicDepth > 0.6 ? 'explore' : 'precise';

    return { cleanQuery, queryVector, logicDepth, mode };
  }

  // ─── Stage 2: Boost ──────────────────────────────────────────────────

  private boost(queryVector: number[], logicDepth: number): {
    boostedVector: number[];
    matchedTags: string[];
    beta: number;
  } {
    const dim = queryVector.length;

    // 1. Tag sensing: find top-N matching tags
    const topTags = this.tagGraph.getTopTags(queryVector, this.index, this.config.maxBoostTags);
    const matchedTagNames = topTags.map(t => t.tag.name);

    if (topTags.length === 0) {
      return { boostedVector: queryVector, matchedTags: [], beta: 0 };
    }

    // 2. Cooccurrence expansion (1-hop)
    const expanded = this.tagGraph.expand1Hop(matchedTagNames, 10, 0.1);
    const allTagNames = [...matchedTagNames, ...expanded.map(e => e.name)];

    // Collect tag vectors for boost
    const tagVectors: Float32Array[] = [];
    for (const name of allTagNames) {
      const tag = this.tagGraph.getTag(name);
      if (tag && tag.vector.length === dim) {
        tagVectors.push(tag.vector);
      }
    }

    if (tagVectors.length === 0) {
      return { boostedVector: queryVector, matchedTags: matchedTagNames, beta: 0 };
    }

    // 3. Residual compensation: project query onto tag subspace
    let residualVector: number[] | null = null;
    if (this.config.residualIterations > 0 && tagVectors.length > 0) {
      try {
      const tagsBuf = Buffer.alloc(tagVectors.length * dim * 4);
        for (let i = 0; i < tagVectors.length; i++) {
          const tv = tagVectors[i];
          for (let j = 0; j < dim; j++) {
            tagsBuf.writeFloatLE(tv[j], (i * dim + j) * 4);
          }
        }
        const proj = this.index.computeOrthogonalProjection(
          vectorToBuffer(queryVector), tagsBuf, tagVectors.length,
        );
        residualVector = proj.residual.map(v => v as number);
      } catch (err) {
        logger.debug(MODULE, 'Residual compensation skipped', err);
      }
    }

    // 4. Dynamic beta: β = sigmoid(logicDepth × log(1 + coverage))
    const coverage = topTags.length / Math.max(1, this.tagGraph.size);
    const rawBeta = logicDepth * Math.log(1 + coverage);
    const sigmoid = 1 / (1 + Math.exp(-rawBeta));
    const [betaMin, betaMax] = this.config.boostBeta;
    const beta = betaMin + sigmoid * (betaMax - betaMin);

    // 5. Vector fusion: Q' = normalize(Q + β × Σ(tagVectors × similarity))
    const boosted = new Float64Array(dim);
    for (let i = 0; i < dim; i++) boosted[i] = queryVector[i];

    for (const { tag, similarity } of topTags) {
      if (tag.vector.length === dim) {
        for (let i = 0; i < dim; i++) {
          boosted[i] += beta * similarity * tag.vector[i];
        }
      }
    }

    // Add weighted residual if available (captures unexplored dimensions)
    if (residualVector) {
      const residualWeight = beta * 0.3; // residual gets less weight
      for (let i = 0; i < dim; i++) {
        boosted[i] += residualWeight * residualVector[i];
      }
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += boosted[i] * boosted[i];
    norm = Math.sqrt(norm);
    const result = new Array<number>(dim);
    for (let i = 0; i < dim; i++) result[i] = norm > 1e-10 ? boosted[i] / norm : 0;

    return { boostedVector: result, matchedTags: matchedTagNames, beta };
  }

  // ─── Stage 3: Retrieve ───────────────────────────────────────────────

  private retrieve(
    boostedVector: number[],
    originalVector: number[],
    matchedTags: string[],
  ): PipelineResult[] {
    const topK = this.config.topK;
    const minSim = this.config.minSimilarity;

    // 1. Primary search with boosted vector
    const primaryResults = this.index.search(vectorToBuffer(boostedVector), topK * 3);

    // 2. Residual search (if boost changed the vector significantly)
    let residualResults: typeof primaryResults = [];
    const boostedBuf = vectorToBuffer(boostedVector);
    const origBuf = vectorToBuffer(originalVector);
    const vectorDrift = 1 - this.index.cosineSimilarity(boostedBuf, origBuf);

    if (vectorDrift > 0.05) {
      // Significant boost → also search with original vector and merge
      residualResults = this.index.search(origBuf, topK);
    }

    // 3. Merge and deduplicate
    const seen = new Map<number, { score: number; isResidual: boolean }>();

    for (const r of primaryResults) {
      if (r.score >= minSim) seen.set(r.id, { score: r.score, isResidual: false });
    }
    for (const r of residualResults) {
      if (r.score >= minSim && !seen.has(r.id)) {
        seen.set(r.id, { score: r.score, isResidual: true });
      }
    }

    // 4. Build result objects
    let results: PipelineResult[] = [];
    for (const [id, { score, isResidual }] of seen) {
      const chunk = this.meta[id];
      if (!chunk) continue;
      results.push({
        id,
        content: chunk.content,
        filePath: chunk.filePath,
        heading: chunk.heading,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        similarity: Math.round(score * 1000) / 1000,
        matchedTags: matchedTags.length > 0 ? matchedTags : undefined,
        isResidualFind: isResidual || undefined,
      });
    }

    // 5. Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    // 6. Semantic dedup: remove results that are too similar to higher-ranked ones
    results = this.semanticDedup(results);

    // 7. Truncate to topK
    return results.slice(0, topK);
  }

  // ─── Semantic dedup ──────────────────────────────────────────────────

  private semanticDedup(results: PipelineResult[]): PipelineResult[] {
    if (results.length <= 1) return results;

    const threshold = this.config.dedupThreshold;
    const kept: PipelineResult[] = [results[0]];

    for (let i = 1; i < results.length; i++) {
      const candidate = results[i];
      let isDuplicate = false;

      // Compare text-level similarity (fast, avoids re-embedding)
      for (const existing of kept) {
        const textSim = this.textSimilarity(candidate.content, existing.content);
        if (textSim > threshold) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) kept.push(candidate);
    }

    return kept;
  }

  /** Fast text similarity: Jaccard coefficient on token sets */
  private textSimilarity(a: string, b: string): number {
    const tokensA = new Set(tokenize(a));
    const tokensB = new Set(tokenize(b));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    return intersection / (tokensA.size + tokensB.size - intersection);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /** Get a sample of existing vectors by re-embedding chunk content */
  private async getSampleVectors(n: number): Promise<number[][]> {
    const ids = Object.keys(this.meta).map(Number);
    if (ids.length === 0) return [];

    // Take evenly-spaced sample across all chunks for representativeness
    const step = Math.max(1, Math.floor(ids.length / n));
    const sampleIds = ids.filter((_, i) => i % step === 0).slice(0, n);
    const texts = sampleIds.map(id => this.meta[id]?.content).filter(Boolean);

    if (texts.length === 0) return [];

    try {
      return await embed(texts, this.embedOpts);
    } catch (err) {
      logger.debug(MODULE, 'Sample vector fetch failed', err);
      return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Graph Builder (runs during init/sync)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build or update the tag graph from chunk metadata.
 * Extracts tags from content via TF-IDF, computes tag embeddings,
 * and builds the cooccurrence matrix.
 */
export async function buildTagGraph(
  chunks: Array<{ content: string; filePath: string }>,
  embedOpts: EmbedOptions,
  existingGraph?: TagGraph,
): Promise<TagGraph> {
  const graph = existingGraph ?? new TagGraph();

  // 1. Extract tags via TF-IDF
  const tags = extractTags(chunks, 50);
  logger.info(MODULE, `Extracted ${tags.length} tags via TF-IDF`);

  if (tags.length === 0) return graph;

  // 2. Compute tag embeddings (batch)
  const tagNames = tags.map(t => t.name);
  const BATCH = 50;
  const tagVectors: number[][] = [];

  for (let i = 0; i < tagNames.length; i += BATCH) {
    const batch = tagNames.slice(i, i + BATCH);
    const vecs = await embed(batch, embedOpts);
    tagVectors.push(...vecs);
  }

  // 3. Add tags to graph
  for (let i = 0; i < tags.length; i++) {
    graph.setTag(tags[i].name, tagVectors[i], tags[i].score);
  }

  // 4. Assign tags to chunks and build cooccurrence
  const chunkTagAssignments: string[][] = [];
  for (const chunk of chunks) {
    const chunkTokens = new Set(tokenize(chunk.content));
    const assigned = tagNames.filter(t => chunkTokens.has(t));
    chunkTagAssignments.push(assigned);
  }
  graph.buildCooccurrence(chunkTagAssignments);

  logger.info(MODULE, `Tag graph: ${graph.size} tags, cooccurrence built`);
  return graph;
}
