// src/chunker-tree.ts
// Tree-sitter based smart code chunking strategy
// Splits code by function/class/method boundaries with contextual header injection

import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Chunk } from './chunker.js';

// ═══════════════════════════════════════════════════════════════════════════
// Language map: file extension → Tree-sitter grammar name
// ═══════════════════════════════════════════════════════════════════════════

const LANG_MAP: Record<string, string> = {
  '.ts':   'typescript',
  '.tsx':  'tsx',
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.mjs':  'javascript',
  '.py':   'python',
  '.rs':   'rust',
  '.go':   'go',
  '.java': 'java',
  '.c':    'c',
  '.h':    'c',
  '.cpp':  'cpp',
  '.cc':   'cpp',
  '.hpp':  'cpp',
  '.rb':   'ruby',
  '.php':  'php',
  '.cs':   'c_sharp',
  '.swift':'swift',
  '.kt':   'kotlin',
  '.lua':  'lua',
  '.zig':  'zig',
};

/** Node types that represent top-level code structures worth splitting on */
const SPLIT_NODES = new Set([
  // Functions
  'function_declaration', 'function_definition', 'function_item',
  'arrow_function', 'method_definition', 'method_declaration',
  // Classes / structs
  'class_declaration', 'class_definition', 'struct_item',
  'interface_declaration', 'type_alias_declaration', 'enum_declaration',
  'enum_item', 'impl_item', 'trait_item',
  // Module-level
  'export_statement', 'decorated_definition',
]);

/** Node types that represent import/require statements */
const IMPORT_NODES = new Set([
  'import_statement', 'import_from_statement',
  'use_declaration', 'extern_crate_declaration',
  'package_declaration', 'import_declaration',
]);

export function getSupportedExtensions(): string[] {
  return Object.keys(LANG_MAP);
}

// ═══════════════════════════════════════════════════════════════════════════
// Lazy-loaded Tree-sitter parser (singleton per language)
// ═══════════════════════════════════════════════════════════════════════════

let Parser: any = null;
let Language: any = null;
const loadedLangs = new Map<string, any>();

async function getParser(langName: string): Promise<any | null> {
  try {
    if (!Parser) {
      const mod = await import('web-tree-sitter');
      // v0.25+ exports { Parser, Language }, v0.24 exports Parser as default with Parser.Language
      const TSParser = (mod as any).Parser ?? mod.default ?? mod;
      Language = (mod as any).Language ?? TSParser.Language;

      // v0.25+ uses tree-sitter.wasm, v0.24 uses web-tree-sitter.wasm
      let wasmPath = findInNodeModules('web-tree-sitter', 'tree-sitter.wasm');
      if (!existsSync(wasmPath)) {
        wasmPath = findInNodeModules('web-tree-sitter', 'web-tree-sitter.wasm');
      }

      await TSParser.init({
        locateFile: () => wasmPath,
      });
      Parser = TSParser;
    }

    if (!loadedLangs.has(langName)) {
      const wasmFile = `tree-sitter-${langName}.wasm`;
      const wasmPath = findInNodeModules('tree-sitter-wasms', join('out', wasmFile));
      if (!wasmPath || !existsSync(wasmPath)) {
        return null;
      }
      const lang = await Language.load(wasmPath);
      loadedLangs.set(langName, lang);
    }

    const parser = new Parser();
    parser.setLanguage(loadedLangs.get(langName)!);
    return parser;
  } catch {
    return null;
  }
}

/** Find a file within a node_modules package by walking up directories */
function findInNodeModules(pkg: string, relativePath: string): string {
  const startDirs = [
    import.meta.dirname,
    process.cwd(),
  ].filter(Boolean) as string[];

  for (const startDir of startDirs) {
    let dir = startDir;
    while (true) {
      const candidate = join(dir, 'node_modules', pkg, relativePath);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Last resort: cwd
  return join(process.cwd(), 'node_modules', pkg, relativePath);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Chunk a code file using Tree-sitter AST analysis.
 * Returns null if the language is unsupported or parsing fails (caller should fallback).
 */
export async function chunkCodeWithTreeSitter(
  content: string,
  ext: string,
  maxSize = 512,
  overlap = 64,
  filePath?: string,
): Promise<Chunk[] | null> {
  const langName = LANG_MAP[ext.toLowerCase()];
  if (!langName) return null;

  const parser = await getParser(langName);
  if (!parser) return null;

  try {
    const tree = parser.parse(content);
    const root = tree.rootNode;
    const lines = content.split('\n');

    // 1. Extract imports for contextual header
    const imports = extractImports(root);
    const importHeader = imports.length > 0
      ? imports.slice(0, 5).join('\n') + (imports.length > 5 ? '\n// ...' : '')
      : '';

    // 2. Split by top-level structures
    const chunks: Chunk[] = [];
    const visited = new Set<number>();  // track visited byte ranges to avoid duplication

    collectStructures(root, lines, chunks, visited, maxSize, overlap, importHeader, filePath, 0);

    // 3. Handle interstitial code (top-level code between structures)
    const interstitialChunks = collectInterstitial(root, lines, visited, maxSize, overlap, importHeader, filePath);
    chunks.push(...interstitialChunks);

    // 4. Sort by start line
    chunks.sort((a, b) => a.startLine - b.startLine);

    return chunks.length > 0 ? chunks : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function extractImports(root: any): string[] {
  const imports: string[] = [];
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (IMPORT_NODES.has(node.type)) {
      imports.push(node.text.trim());
    }
    // Handle decorated/exported imports
    if (node.type === 'export_statement' && node.childCount > 0) {
      const inner = node.child(node.childCount - 1);
      if (inner && IMPORT_NODES.has(inner.type)) {
        imports.push(node.text.trim());
      }
    }
  }
  return imports;
}

function collectStructures(
  node: any, lines: string[], chunks: Chunk[],
  visited: Set<number>, maxSize: number, overlap: number,
  importHeader: string, filePath?: string, depth = 0,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (SPLIT_NODES.has(child.type) && !visited.has(child.startIndex)) {
      const startLine = child.startPosition.row + 1;
      const endLine = child.endPosition.row + 1;
      const text = child.text;

      // Build contextual header
      const heading = buildHeading(child, filePath);

      // Mark as visited
      for (let b = child.startIndex; b <= child.endIndex; b++) visited.add(b);

      if (text.length <= maxSize) {
        // Fits in one chunk — prepend header
        const finalContent = importHeader
          ? `${importHeader}\n\n${text}`
          : text;
        chunks.push({ content: finalContent, heading, startLine, endLine });
      } else {
        // Too large — split internally with sliding window
        const subChunks = splitLargeNode(text, heading, startLine, endLine, maxSize, overlap, importHeader);
        chunks.push(...subChunks);
      }
    } else if (!IMPORT_NODES.has(child.type) && depth < 2) {
      // Recurse into non-import nodes (e.g., exported declarations)
      collectStructures(child, lines, chunks, visited, maxSize, overlap, importHeader, filePath, depth + 1);
    }
  }
}

function collectInterstitial(
  root: any, lines: string[], visited: Set<number>,
  maxSize: number, overlap: number,
  importHeader: string, filePath?: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
  let currentStart = -1;
  let currentEnd = -1;

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (IMPORT_NODES.has(child.type)) continue;
    if (visited.has(child.startIndex)) continue;

    const startLine = child.startPosition.row + 1;
    const endLine = child.endPosition.row + 1;
    const text = child.text.trim();
    if (!text) continue;

    if (currentStart < 0) currentStart = startLine;
    currentEnd = endLine;

    if (current.length + text.length + 1 > maxSize && current.length > 0) {
      chunks.push({ content: current.trim(), heading: filePath ? `[${filePath}] top-level` : 'top-level', startLine: currentStart, endLine: currentEnd });
      current = current.slice(-overlap) + '\n' + text;
      currentStart = startLine;
    } else {
      current += (current ? '\n' : '') + text;
    }
  }

  if (current.trim().length > 0 && currentStart > 0) {
    chunks.push({ content: current.trim(), heading: filePath ? `[${filePath}] top-level` : 'top-level', startLine: currentStart, endLine: currentEnd });
  }
  return chunks;
}

function buildHeading(node: any, filePath?: string): string {
  const parts: string[] = [];
  if (filePath) parts.push(`[${filePath}]`);

  // Walk up to find parent class/struct
  let parent = node.parent;
  while (parent && parent.type !== 'program' && parent.type !== 'source_file') {
    if (parent.type === 'class_declaration' || parent.type === 'class_definition' ||
        parent.type === 'impl_item' || parent.type === 'interface_declaration') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode) parts.push(nameNode.text);
    }
    parent = parent.parent;
  }

  // Get this node's name
  const nameNode = node.childForFieldName('name') || node.childForFieldName('declarator');
  if (nameNode) {
    parts.push(nameNode.text);
  } else {
    parts.push(node.type.replace(/_/g, ' '));
  }

  return parts.join(' > ');
}

function splitLargeNode(
  text: string, heading: string, startLine: number, endLine: number,
  maxSize: number, overlap: number, importHeader: string,
): Chunk[] {
  const nodeLines = text.split('\n');
  const chunks: Chunk[] = [];
  let current = importHeader ? importHeader + '\n\n' : '';
  let chunkStart = startLine;

  for (let i = 0; i < nodeLines.length; i++) {
    const line = nodeLines[i];
    if (current.length + line.length + 1 > maxSize && current.length > 0) {
      chunks.push({
        content: current.trim(),
        heading,
        startLine: chunkStart,
        endLine: startLine + i - 1,
      });
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n' + line;
      chunkStart = startLine + i;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current.trim().length > 0) {
    chunks.push({ content: current.trim(), heading, startLine: chunkStart, endLine });
  }
  return chunks;
}
