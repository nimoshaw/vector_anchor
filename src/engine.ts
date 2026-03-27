// src/engine.ts
// Core engine: anchor resolution + AnchorManager (init/search/sync/status/recovery)

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, appendFileSync, watch as fsWatch } from 'fs';
import { createHash } from 'crypto';
import { join, extname, relative, resolve, dirname } from 'path';
import { AnchorIndex } from 'anchor-core';
import { chunkFile, type Chunk } from './chunker.js';
import { embed, vectorToBuffer, type EmbedOptions } from './embedding.js';
import {
  loadAnchorConfig, saveAnchorConfig, saveRagParams, loadRagParams,
  type AnchorConfig, type ResolvedModel,
  DEFAULT_ANCHOR_CONFIG, DEFAULT_RAG_PARAMS, logger,
} from './utils.js';
import { resolveModelConfig, generateFingerprint, checkFingerprint, executeMigration } from './model.js';
import { SearchPipeline, TagGraph, buildTagGraph, type PipelineResult } from './pipeline.js';

const MODULE = 'Engine';
const ANCHOR_DIR = '.anchor';

// ═══════════════════════════════════════════════════════════════════════════
// Anchor resolver (walks up directory tree)
// ═══════════════════════════════════════════════════════════════════════════

export interface ResolvedAnchor {
  anchorDir: string;
  projectRoot: string;
  depth: number;
}

const resolveCache = new Map<string, ResolvedAnchor>();

export function resolveAnchor(startPath: string): ResolvedAnchor | null {
  const absPath = resolve(startPath);
  const cached = resolveCache.get(absPath);
  if (cached) return cached;

  let current = absPath;
  let depth = 0;

  while (true) {
    const anchorDir = join(current, ANCHOR_DIR);
    if (existsSync(anchorDir)) {
      const result: ResolvedAnchor = { anchorDir, projectRoot: current, depth };
      resolveCache.set(absPath, result);
      return result;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
    depth++;
  }
}

export function clearResolveCache() { resolveCache.clear(); }

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface InitOptions { force?: boolean; onModelChange?: 'rebuild' | 'lazy' | 'warn'; }
export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  /** Use enhanced 3-stage pipeline (default: true if tag graph available) */
  enhanced?: boolean;
  /** Scope mode for hierarchical search */
  scope?: 'local' | 'bubble' | 'cascade' | 'merge';
}
export interface SearchResultItem {
  content: string; filePath: string; heading: string;
  startLine: number; endLine: number; similarity: number;
  matchedTags?: string[];
  isResidualFind?: boolean;
}
/** Extended search result with pipeline metadata for context folding */
export interface SearchResult {
  items: SearchResultItem[];
  /** Pipeline metadata — available when enhanced pipeline is used */
  pipelineMeta?: { logicDepth: number; mode: 'precise' | 'explore'; matchedTags: string[]; elapsedMs: number };
}
export interface AnchorStatusInfo {
  projectRoot: string; totalFiles: number; totalChunks: number;
  totalVectors: number; dimensions: number; modelId: string;
  fingerprint: string; dbSizeBytes: number; indexSizeBytes: number;
  tagCount: number;
  migrationWarning?: string;
}
export interface SyncResult { added: number; updated: number; removed: number; totalChunks: number; }

/** Anchor tree node for visualization */
export interface AnchorTreeNode {
  path: string;
  vectors: number;
  tags: number;
  children: AnchorTreeNode[];
}

// ═══════════════════════════════════════════════════════════════════════════
// AnchorManager
// ═══════════════════════════════════════════════════════════════════════════

export class AnchorManager {
  private projectRoot: string;
  private anchorDir: string;
  private config: AnchorConfig;
  private index: InstanceType<typeof AnchorIndex> | null = null;
  private embedOptions: EmbedOptions | null = null;
  private tagGraph: TagGraph = new TagGraph();
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** In-memory meta cache — avoids disk reads on every search */
  private _metaCache: Record<number, any> | null = null;
  private _ragCache: import('./utils.js').RagParams | null = null;
  migrationWarning: string | undefined;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.anchorDir = join(this.projectRoot, ANCHOR_DIR);
    this.config = DEFAULT_ANCHOR_CONFIG;
  }

  /** Release all heavy in-memory resources (called by LRU eviction) */
  destroy(): void {
    this.stopWatch();
    this.index = null;
    this._metaCache = null;
    this._ragCache = null;
    this.tagGraph = new TagGraph();
    logger.info(MODULE, `Destroyed manager: ${this.projectRoot}`);
  }

  // ── Init ─────────────────────────────────────────────────────────────

  async init(apiKey: string, modelName: string, baseUrl?: string, options: InitOptions = {}): Promise<string> {
    logger.info(MODULE, `Initializing at ${this.projectRoot}`);

    if (!existsSync(this.anchorDir)) mkdirSync(this.anchorDir, { recursive: true });

    const { resolved } = await resolveModelConfig({ api_key: apiKey, model: modelName, base_url: baseUrl || undefined });
    this.embedOptions = { apiKey, resolved };

    if (!resolved.dimensions) {
      const probe = await embed(['hello'], this.embedOptions);
      resolved.dimensions = probe[0].length;
    }

    // Fingerprint
    const fp = await generateFingerprint(this.embedOptions);

    // DB + Index
    const dbPath = join(this.anchorDir, 'index.db');
    AnchorIndex.initDatabase(dbPath);
    this.index = new AnchorIndex(resolved.dimensions, 10000);

    // Config
    this.config = {
      ...DEFAULT_ANCHOR_CONFIG,
      resolved_model: resolved,
      model_migration: { ...DEFAULT_ANCHOR_CONFIG.model_migration!, strategy: options.onModelChange ?? 'warn' },
      _fingerprint: fp.fingerprint,
      _dimensions: fp.dimensions,
    };
    saveAnchorConfig(this.anchorDir, this.config);
    saveRagParams(this.anchorDir, DEFAULT_RAG_PARAMS);
    this.autoConfigIgnoreFiles();

    // Scan & index
    const files = this.scanFiles();
    let totalChunks = 0;
    const allChunkData: Array<{ content: string; filePath: string }> = [];
    const BATCH = 20;
    for (let i = 0; i < files.length; i += BATCH) {
      const batchChunks = await this.processBatch(files.slice(i, i + BATCH));
      totalChunks += batchChunks.count;
      allChunkData.push(...batchChunks.chunks);
      logger.info(MODULE, `Progress: ${Math.min(i + BATCH, files.length)}/${files.length} files`);
    }

    const indexPath = join(this.anchorDir, 'vectors.usearch');
    this.index.save(indexPath);

    // Build tag graph (Phase 2B)
    try {
      this.tagGraph = await buildTagGraph(allChunkData, this.embedOptions);
      const tagPath = join(this.anchorDir, 'tag_graph.json');
      writeFileSync(tagPath, JSON.stringify(this.tagGraph.toJSON()), 'utf-8');
      logger.info(MODULE, `Tag graph: ${this.tagGraph.size} tags saved`);
    } catch (err) {
      logger.warn(MODULE, 'Tag graph build skipped (non-fatal)', err);
    }

    return `✅ Anchor initialized\n   Path: ${this.projectRoot}\n   Files: ${files.length}\n   Chunks: ${totalChunks}\n   Tags: ${this.tagGraph.size}\n   Model: ${resolved.model} (dim=${resolved.dimensions})`;
  }

  // ── Hierarchy (Phase 2.5) ──────────────────────────────────────────

  /** Discover parent anchor, register this anchor with it, and discover children */
  discoverHierarchy(): void {
    // 1. Find parent anchor (walk up from parent directory)
    const parentDir = dirname(this.projectRoot);
    const parent = resolveAnchor(parentDir);
    if (parent && parent.projectRoot !== this.projectRoot) {
      this.config.parent = relative(this.projectRoot, parent.projectRoot) || null;
      // Register this anchor as a child of the parent
      try {
        const parentConfig = loadAnchorConfig(parent.anchorDir);
        const childRelPath = relative(parent.projectRoot, this.projectRoot);
        if (!parentConfig.children.includes(childRelPath)) {
          parentConfig.children.push(childRelPath);
          saveAnchorConfig(parent.anchorDir, parentConfig);
          logger.info(MODULE, `Registered with parent: ${parent.projectRoot}`);
        }
      } catch (err) {
        logger.warn(MODULE, 'Failed to register with parent', err);
      }
    }

    // 2. Discover children (subdirectories with .anchor)
    this.config.children = this.findChildAnchors();
    saveAnchorConfig(this.anchorDir, this.config);
  }

  /** Scan for child anchor directories */
  private findChildAnchors(): string[] {
    const children: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = join(dir, e.name);
        if (e.name === '.anchor' || e.name === '.git' || e.name === 'node_modules') continue;
        if (existsSync(join(full, ANCHOR_DIR)) && full !== this.projectRoot) {
          children.push(relative(this.projectRoot, full));
          // Don't recurse into child anchors (they manage their own children)
        } else {
          walk(full);
        }
      }
    };
    walk(this.projectRoot);
    return children;
  }

  /** Build anchor hierarchy tree for visualization */
  anchorTree(): AnchorTreeNode {
    const self = this;
    const buildNode = (root: string): AnchorTreeNode => {
      const anchorDir = join(root, ANCHOR_DIR);
      let vectors = 0, tags = 0;
      try {
        const cfg = loadAnchorConfig(anchorDir);

        // Use in-memory caches for current node, disk for children
        if (root === self.projectRoot) {
          vectors = self._metaCache ? Object.keys(self._metaCache).length : 0;
          tags = self.tagGraph.size;
        } else {
          const metaPath = join(anchorDir, 'chunk_meta.json');
          if (existsSync(metaPath)) {
            vectors = Object.keys(JSON.parse(readFileSync(metaPath, 'utf-8'))).length;
          }
          const tagPath = join(anchorDir, 'tag_graph.json');
          if (existsSync(tagPath)) {
            const data = JSON.parse(readFileSync(tagPath, 'utf-8'));
            tags = data.tags?.length ?? 0;
          }
        }

        // Recurse into children
        const children = (cfg.children ?? []).map((childRel: string) => {
          const childRoot = resolve(root, childRel);
          if (existsSync(join(childRoot, ANCHOR_DIR))) return buildNode(childRoot);
          return null;
        }).filter(Boolean) as AnchorTreeNode[];

        return { path: root, vectors, tags, children };
      } catch {
        return { path: root, vectors: 0, tags: 0, children: [] };
      }
    };

    return buildNode(this.projectRoot);
  }

  /** Get tag graph inspection data */
  tagInspect(tagName?: string): { total: number; tags: Array<{ name: string; weight: number; connections: number }> } | { name: string; weight: number; cooccurring: Array<{ name: string; weight: number }> } {
    if (tagName) {
      const tag = this.tagGraph.getTag(tagName);
      if (!tag) return { name: tagName, weight: 0, cooccurring: [] };
      const expanded = this.tagGraph.expand1Hop([tagName], 20, 0.01);
      return { name: tagName, weight: tag.weight, cooccurring: expanded };
    }
    // List all tags with connection count
    const allTags = this.tagGraph.allTags();
    return {
      total: allTags.length,
      tags: allTags.slice(0, 50).map(t => {
        const connections = this.tagGraph.expand1Hop([t.name], 100, 0.01).length;
        return { name: t.name, weight: t.weight, connections };
      }),
    };
  }

  // ── Search ───────────────────────────────────────────────────────────

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const scope = options.scope ?? 'local';

    // Scoped search: collect results from multiple anchors
    if (scope !== 'local') {
      return this.scopedSearch(query, options, scope);
    }

    return this.localSearch(query, options);
  }

  /** Scope-aware search across hierarchy */
  private async scopedSearch(
    query: string, options: SearchOptions,
    scope: 'bubble' | 'cascade' | 'merge',
  ): Promise<SearchResult> {
    const topK = options.topK ?? 10;
    const localOpts: SearchOptions = { ...options, scope: 'local' };
    let allResults: SearchResultItem[] = [];
    let pipelineMeta: SearchResult['pipelineMeta'];

    // Local results first
    const localResult = await this.localSearch(query, localOpts);
    allResults.push(...localResult.items);
    pipelineMeta = localResult.pipelineMeta;

    if (scope === 'bubble' || scope === 'merge') {
      // Walk up to parent anchors
      let parentPath = this.config.parent ? resolve(this.projectRoot, this.config.parent) : null;
      while (parentPath && existsSync(join(parentPath, ANCHOR_DIR))) {
        try {
          const parentMgr = new AnchorManager(parentPath);
          const parentCfg = loadAnchorConfig(join(parentPath, ANCHOR_DIR));
          if (parentCfg.resolved_model) {
            parentMgr.setEmbedOptions({ apiKey: this.embedOptions?.apiKey ?? '', resolved: parentCfg.resolved_model });
          }
          const parentResult = await parentMgr.localSearch(query, localOpts);
          // Prefix file paths with relative path from this project
          const relPrefix = relative(this.projectRoot, parentPath);
          allResults.push(...parentResult.items.map(r => ({
            ...r, filePath: join(relPrefix, r.filePath),
          })));
        } catch (err) {
          logger.debug(MODULE, `Bubble skip: ${parentPath}`, err);
        }
        // Continue bubbling?
        if (scope === 'bubble') break; // bubble only goes one level up
        const nextParent = loadAnchorConfig(join(parentPath, ANCHOR_DIR)).parent;
        parentPath = nextParent ? resolve(parentPath, nextParent) : null;
      }
    }

    if (scope === 'cascade' || scope === 'merge') {
      // Search child anchors
      for (const childRel of this.config.children) {
        const childRoot = resolve(this.projectRoot, childRel);
        if (!existsSync(join(childRoot, ANCHOR_DIR))) continue;
        try {
          const childMgr = new AnchorManager(childRoot);
          const childCfg = loadAnchorConfig(join(childRoot, ANCHOR_DIR));
          if (childCfg.resolved_model) {
            childMgr.setEmbedOptions({ apiKey: this.embedOptions?.apiKey ?? '', resolved: childCfg.resolved_model });
          }
          const childResult = await childMgr.localSearch(query, localOpts);
          allResults.push(...childResult.items.map(r => ({
            ...r, filePath: join(childRel, r.filePath),
          })));
        } catch (err) {
          logger.debug(MODULE, `Cascade skip: ${childRoot}`, err);
        }
      }
    }

    // Deduplicate by file path + content overlap, sort by similarity
    const seen = new Set<string>();
    const deduped: SearchResultItem[] = [];
    allResults.sort((a, b) => b.similarity - a.similarity);
    for (const r of allResults) {
      const key = `${r.filePath}:${r.startLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }

    return { items: deduped.slice(0, topK), pipelineMeta };
  }

  /** Local-only search (no hierarchy traversal) */
  private async localSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const topK = options.topK ?? 10;
    const minSim = options.minSimilarity ?? 0.25;
    await this.ensureLoaded();
    if (!this.embedOptions || !this.index) throw new Error('Not loaded. Run anchor_init first.');

    // Use enhanced pipeline if tags available (default), or fallback to basic HNSW
    const useEnhanced = options.enhanced !== false && this.tagGraph.size > 0;

    if (useEnhanced) {
      const meta = this._metaCache ?? this.loadMeta();
      const ragParams = this._ragCache ?? loadRagParams(this.anchorDir);
      if (!this._ragCache) this._ragCache = ragParams;
      const pipeline = new SearchPipeline(this.index, this.embedOptions, this.tagGraph, meta, {
        topK,
        minSimilarity: minSim,
        boostBeta: ragParams.boost_beta_range as [number, number],
        residualIterations: ragParams.residual_iterations,
        dedupThreshold: ragParams.dedup_threshold,
        maxBoostTags: ragParams.tag_recall_top_n,
      });
      const { results, meta: pMeta } = await pipeline.searchWithMeta(query);
      return { items: results, pipelineMeta: pMeta };
    }

    // Basic fallback: direct HNSW search
    const qVec = await embed([query], this.embedOptions);
    const results = this.index.search(vectorToBuffer(qVec[0]), topK * 2);
    const items: SearchResultItem[] = [];

    for (const r of results) {
      if (r.score < minSim || items.length >= topK) break;
      const chunk = this.getChunkById(r.id);
      if (chunk) items.push({ ...chunk, similarity: Math.round(r.score * 1000) / 1000, matchedTags: undefined, isResidualFind: undefined });
    }
    return { items };
  }

  // ── Load / Recover ───────────────────────────────────────────────────

  async ensureLoaded(): Promise<void> {
    if (this.index) return;
    if (!existsSync(join(this.anchorDir, 'config.json'))) {
      throw new Error(`No anchor at ${this.anchorDir}. Run anchor_init first.`);
    }
    this.config = loadAnchorConfig(this.anchorDir);
    const resolved = this.config.resolved_model;
    if (!resolved) throw new Error('No resolved model. Run anchor_init first.');

    const indexPath = join(this.anchorDir, 'vectors.usearch');
    try {
      if (!existsSync(indexPath)) throw new Error('missing');
      this.index = AnchorIndex.load(indexPath, resolved.dimensions, 10000);
      logger.info(MODULE, `Loaded: dim=${resolved.dimensions}, vectors=${this.index.stats().totalVectors}`);
    } catch {
      logger.warn(MODULE, 'HNSW load failed, recovering...');
      this.index = await this.recoverIndex(resolved.dimensions);
    }

    // Load tag graph if available
    const tagPath = join(this.anchorDir, 'tag_graph.json');
    try {
      if (existsSync(tagPath)) {
        const data = JSON.parse(readFileSync(tagPath, 'utf-8'));
        this.tagGraph = TagGraph.fromJSON(data);
        logger.info(MODULE, `Tag graph loaded: ${this.tagGraph.size} tags`);
      }
    } catch (err) {
      logger.warn(MODULE, 'Tag graph load failed (non-fatal)', err);
    }
  }

  setEmbedOptions(opts: EmbedOptions) { this.embedOptions = opts; }

  async checkModelFingerprint(): Promise<string | undefined> {
    if (!this.embedOptions) return undefined;
    const check = await checkFingerprint(this.embedOptions, this.config._fingerprint ?? null, this.config._dimensions ?? null);
    const result = executeMigration(check, this.config.model_migration?.strategy ?? 'warn');
    if (result.action === 'none') return undefined;
    this.migrationWarning = result.message;
    return result.message;
  }

  private async recoverIndex(dim: number): Promise<InstanceType<typeof AnchorIndex>> {
    const idx = new AnchorIndex(dim, 10000);
    const metaPath = join(this.anchorDir, 'chunk_meta.json');
    if (!existsSync(metaPath) || !this.embedOptions) return idx;

    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const entries = Object.entries(meta);
      logger.info(MODULE, `Recovering ${entries.length} vectors...`);

      for (let i = 0; i < entries.length; i += 50) {
        const batch = entries.slice(i, i + 50);
        const vecs = await embed(batch.map(([_, m]: [string, any]) => m.content), this.embedOptions);
        for (let j = 0; j < batch.length; j++) {
          idx.add(parseInt(batch[j][0], 10), vectorToBuffer(vecs[j]));
        }
      }
      idx.save(join(this.anchorDir, 'vectors.usearch'));
      logger.info(MODULE, `Recovered ${idx.stats().totalVectors} vectors`);
    } catch (err) {
      logger.error(MODULE, 'Recovery failed', err);
    }
    return idx;
  }

  // ── Sync / Status ────────────────────────────────────────────────────

  async sync(force = false): Promise<SyncResult> {
    await this.ensureLoaded();
    if (!this.embedOptions || !this.index) throw new Error('Not loaded.');

    const currentFiles = this.scanFiles();
    const meta = this.loadMeta();

    // Build file → hash map from chunk_meta
    const indexedFiles = new Map<string, string>();
    for (const [, chunk] of Object.entries(meta)) {
      if (!indexedFiles.has(chunk.filePath)) {
        indexedFiles.set(chunk.filePath, chunk._fileHash ?? '');
      }
    }

    // Compute current file hashes
    const currentHashes = new Map<string, string>();
    for (const fp of currentFiles) {
      try {
        const content = readFileSync(join(this.projectRoot, fp), 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        currentHashes.set(fp, hash);
      } catch { /* skip unreadable */ }
    }

    // Detect changes
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [fp, hash] of currentHashes) {
      if (!indexedFiles.has(fp)) {
        added.push(fp);
      } else if (force || indexedFiles.get(fp) !== hash) {
        updated.push(fp);
      }
    }
    for (const fp of indexedFiles.keys()) {
      if (!currentHashes.has(fp)) removed.push(fp);
    }

    if (added.length === 0 && updated.length === 0 && removed.length === 0) {
      return { added: 0, updated: 0, removed: 0, totalChunks: this.index.stats().totalVectors };
    }

    // Remove chunks for updated/removed files
    const idsToRemove: number[] = [];
    for (const [idStr, chunk] of Object.entries(meta)) {
      if (updated.includes(chunk.filePath) || removed.includes(chunk.filePath)) {
        idsToRemove.push(parseInt(idStr, 10));
      }
    }
    for (const id of idsToRemove) {
      try { this.index.remove(id); } catch { /* may not exist */ }
      delete meta[id];
    }

    // Re-index added + updated files
    const toProcess = [...added, ...updated];
    const allChunkData: Array<{ content: string; filePath: string }> = [];
    if (toProcess.length > 0) {
      const BATCH = 20;
      for (let i = 0; i < toProcess.length; i += BATCH) {
        const batch = toProcess.slice(i, i + BATCH);
        const batchResult = await this.processBatch(batch, meta, currentHashes);
        allChunkData.push(...batchResult.chunks);
      }
    }

    // Save updated state
    writeFileSync(join(this.anchorDir, 'chunk_meta.json'), JSON.stringify(meta), 'utf-8');
    this.index.save(join(this.anchorDir, 'vectors.usearch'));
    this._metaCache = meta; // Update cache

    logger.info(MODULE, `Sync: +${added.length} ~${updated.length} -${removed.length}`);
    return {
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      totalChunks: this.index.stats().totalVectors,
    };
  }


  // ── File Watcher (Phase 3) ──────────────────────────────────────────

  /** Start watching for file changes (debounced auto-sync) */
  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fsWatch(this.projectRoot, { recursive: true }, (event, filename) => {
        if (!filename) return;
        // Skip .anchor directory changes
        if (filename.startsWith('.anchor') || filename.startsWith('node_modules')) return;
        // Check extension
        const ext = extname(filename).toLowerCase();
        if (!new Set(this.config.extensions).has(ext)) return;

        // Debounce: wait 2s after last change before syncing
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(async () => {
          try {
            logger.info(MODULE, `Watcher: ${event} ${filename}, syncing...`);
            const result = await this.sync();
            logger.info(MODULE, `Watcher sync: +${result.added} ~${result.updated} -${result.removed}`);
          } catch (err) {
            logger.error(MODULE, 'Watcher sync failed', err);
          }
        }, 2000);
      });
      logger.info(MODULE, `File watcher started: ${this.projectRoot}`);
    } catch (err) {
      logger.warn(MODULE, 'File watcher unavailable', err);
    }
  }

  /** Stop file watcher */
  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      if (this.watchDebounce) clearTimeout(this.watchDebounce);
      logger.info(MODULE, 'File watcher stopped');
    }
  }

  // ── Auto Project Detection (Phase 3) ───────────────────────────────

  /** Detect project type and auto-configure extensions/ignore */
  static detectProjectType(projectRoot: string): {
    type: string;
    extensions: string[];
    ignore: string[];
  } {
    const has = (f: string) => existsSync(join(projectRoot, f));

    if (has('package.json')) {
      // Node.js / TypeScript project
      const isTS = has('tsconfig.json');
      return {
        type: isTS ? 'typescript' : 'javascript',
        extensions: isTS
          ? ['.ts', '.tsx', '.js', '.jsx', '.md', '.json', '.yaml', '.yml']
          : ['.js', '.jsx', '.mjs', '.md', '.json', '.yaml', '.yml'],
        ignore: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '*.lock', '.anchor'],
      };
    }
    if (has('Cargo.toml')) {
      return {
        type: 'rust',
        extensions: ['.rs', '.toml', '.md', '.txt'],
        ignore: ['target', '.git', '.anchor'],
      };
    }
    if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) {
      return {
        type: 'python',
        extensions: ['.py', '.md', '.txt', '.yaml', '.yml', '.toml', '.cfg'],
        ignore: ['__pycache__', '.venv', 'venv', '.git', 'dist', 'build', '*.egg-info', '.anchor'],
      };
    }
    if (has('go.mod')) {
      return {
        type: 'go',
        extensions: ['.go', '.md', '.txt', '.yaml', '.yml'],
        ignore: ['vendor', '.git', '.anchor'],
      };
    }
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
      return {
        type: 'java',
        extensions: ['.java', '.kt', '.xml', '.md', '.yaml', '.yml', '.properties'],
        ignore: ['target', 'build', '.gradle', '.idea', '.git', '.anchor'],
      };
    }
    // Default
    return {
      type: 'generic',
      extensions: ['.md', '.txt', '.json', '.yaml', '.yml', '.ts', '.js', '.py', '.rs', '.go'],
      ignore: ['node_modules', '.git', 'dist', 'build', '.anchor'],
    };
  }

  async status(): Promise<AnchorStatusInfo> {
    await this.ensureLoaded();
    const stats = this.index!.stats();
    const resolved = this.config.resolved_model!;
    const dbPath = join(this.anchorDir, 'index.db');
    const idxPath = join(this.anchorDir, 'vectors.usearch');
    let dbSize = 0, idxSize = 0;
    try { dbSize = statSync(dbPath).size; } catch {}
    try { idxSize = statSync(idxPath).size; } catch {}

    return {
      projectRoot: this.projectRoot, totalFiles: this.scanFiles().length,
      totalChunks: stats.totalVectors, totalVectors: stats.totalVectors,
      dimensions: stats.dimensions, modelId: `${resolved.provider}/${resolved.model}`,
      fingerprint: (this.config._fingerprint ?? 'N/A').slice(0, 16) + '...',
      dbSizeBytes: dbSize, indexSizeBytes: idxSize,
      tagCount: this.tagGraph.size,
      migrationWarning: this.migrationWarning,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private scanFiles(): string[] {
    const files: string[] = [];
    const ignoreSet = new Set(this.config.ignore);
    const extSet = new Set(this.config.extensions);

    const walk = (dir: string) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        const rel = relative(this.projectRoot, full);
        if (ignoreSet.has(e.name) || rel.split(/[/\\]/).some(p => ignoreSet.has(p))) continue;
        if (e.isDirectory()) {
          if (existsSync(join(full, ANCHOR_DIR)) && full !== this.projectRoot) continue;
          walk(full);
        } else if (e.isFile() && extSet.has(extname(e.name).toLowerCase())) {
          files.push(rel);
        }
      }
    };
    walk(this.projectRoot);
    return files;
  }

  private async processBatch(
    filePaths: string[],
    externalMeta?: Record<number, any>,
    hashes?: Map<string, string>,
  ): Promise<{ count: number; chunks: Array<{ content: string; filePath: string }> }> {
    const allChunks: Array<{ chunk: Chunk; filePath: string }> = [];

    for (const fp of filePaths) {
      try {
        const content = readFileSync(join(this.projectRoot, fp), 'utf-8');
        const chunks = await chunkFile(content, extname(fp), this.config.chunk_size, this.config.chunk_overlap, fp);
        for (const chunk of chunks) allChunks.push({ chunk, filePath: fp });
      } catch (err) { logger.warn(MODULE, `Failed to read ${fp}`, err); }
    }
    if (allChunks.length === 0) return { count: 0, chunks: [] };

    // Batch embed
    const allVecs: number[][] = [];
    for (let i = 0; i < allChunks.length; i += 100) {
      const texts = allChunks.slice(i, i + 100).map(c => c.chunk.content);
      allVecs.push(...await embed(texts, this.embedOptions!));
    }

    // Use external meta (sync mode) or load from disk (init mode)
    const meta = externalMeta ?? (() => {
      const metaPath = join(this.anchorDir, 'chunk_meta.json');
      try { if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, 'utf-8')); } catch {}
      return {} as Record<number, any>;
    })();
    const maxId = Object.keys(meta).reduce((max, k) => Math.max(max, parseInt(k, 10)), 0);

    for (let i = 0; i < allChunks.length; i++) {
      const id = maxId + 1 + i;
      this.index!.add(id, vectorToBuffer(allVecs[i]));
      const { chunk, filePath } = allChunks[i];
      // Compute file hash for incremental sync support
      const fileHash = hashes?.get(filePath) ?? (() => {
        try {
          return createHash('sha256').update(
            readFileSync(join(this.projectRoot, filePath), 'utf-8'),
          ).digest('hex').slice(0, 16);
        } catch { return ''; }
      })();
      meta[id] = {
        content: chunk.content, filePath, heading: chunk.heading,
        startLine: chunk.startLine, endLine: chunk.endLine,
        _fileHash: fileHash,
      };
    }

    // Write to disk if not using external meta
    if (!externalMeta) {
      writeFileSync(join(this.anchorDir, 'chunk_meta.json'), JSON.stringify(meta), 'utf-8');
    }
    this._metaCache = meta; // Update cache

    return {
      count: allChunks.length,
      chunks: allChunks.map(c => ({ content: c.chunk.content, filePath: c.filePath })),
    };
  }

  private loadMeta(): Record<number, any> {
    if (this._metaCache) return this._metaCache;
    const metaPath = join(this.anchorDir, 'chunk_meta.json');
    try {
      if (!existsSync(metaPath)) return {};
      this._metaCache = JSON.parse(readFileSync(metaPath, 'utf-8'));
      return this._metaCache!;
    } catch { return {}; }
  }

  private getChunkById(id: number): Omit<SearchResultItem, 'similarity'> | null {
    const c = this.loadMeta()[id];
    return c ? { content: c.content, filePath: c.filePath, heading: c.heading, startLine: c.startLine, endLine: c.endLine } : null;
  }

  /** Get adjacent chunks for a given file + line range (for progressive disclosure Level 4) */
  getAdjacentChunks(filePath: string, startLine: number, direction: 'before' | 'after' | 'both' = 'both'): SearchResultItem[] {
    const meta = this.loadMeta();
    const siblings = Object.entries(meta)
      .filter(([, c]) => c.filePath === filePath)
      .sort((a, b) => a[1].startLine - b[1].startLine);

    const idx = siblings.findIndex(([, c]) => c.startLine === startLine);
    if (idx < 0) return [];

    const result: SearchResultItem[] = [];
    if ((direction === 'before' || direction === 'both') && idx > 0) {
      const [, c] = siblings[idx - 1];
      result.push({ content: c.content, filePath: c.filePath, heading: c.heading, startLine: c.startLine, endLine: c.endLine, similarity: 0 });
    }
    if ((direction === 'after' || direction === 'both') && idx < siblings.length - 1) {
      const [, c] = siblings[idx + 1];
      result.push({ content: c.content, filePath: c.filePath, heading: c.heading, startLine: c.startLine, endLine: c.endLine, similarity: 0 });
    }
    return result;
  }

  private autoConfigIgnoreFiles() {
    const gitDir = join(this.projectRoot, '.git');
    if (!existsSync(gitDir)) return;
    const gitignore = join(this.projectRoot, '.gitignore');
    const rules = ['# Vector Anchor', '.anchor/index.db', '.anchor/index.db-wal', '.anchor/index.db-shm', '.anchor/vectors.usearch', '.anchor/chunk_meta.json'];
    let existing = '';
    try { existing = readFileSync(gitignore, 'utf-8'); } catch {}
    if (!existing.includes('.anchor/index.db')) {
      appendFileSync(gitignore, '\n' + rules.join('\n') + '\n');
    }
  }
}
