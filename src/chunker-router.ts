// src/chunker-router.ts
// Strategy router: picks the best chunker for each file type

import type { Chunk } from './chunker.js';
import { chunkMarkdown, chunkText } from './chunker.js';
import { chunkCodeWithTreeSitter, getSupportedExtensions } from './chunker-tree.js';
import { logger } from './utils.js';

const MD_EXTS = new Set(['.md', '.mdx', '.markdown']);
const CODE_EXTS = new Set(getSupportedExtensions());
const MODULE = 'Chunker';

/**
 * Smart file chunker — routes to the best strategy:
 *   1. Markdown files → heading-aware chunker
 *   2. Code files → Tree-sitter AST chunker (with fallback)
 *   3. Everything else → plain text sliding window
 */
export async function chunkFileSmart(
  content: string, ext: string,
  maxSize = 512, overlap = 64,
  filePath?: string,
): Promise<Chunk[]> {
  const lowerExt = ext.toLowerCase();

  // 1. Markdown
  if (MD_EXTS.has(lowerExt)) {
    return chunkMarkdown(content, maxSize, overlap);
  }

  // 2. Code — try Tree-sitter first, fallback to text chunker
  if (CODE_EXTS.has(lowerExt)) {
    try {
      const result = await chunkCodeWithTreeSitter(content, lowerExt, maxSize, overlap, filePath);
      if (result && result.length > 0) {
        return result;
      }
    } catch (err) {
      logger.debug(MODULE, `Tree-sitter failed for ${lowerExt}, falling back to text chunker`, err);
    }
  }

  // 3. Fallback: plain text
  return chunkText(content, maxSize, overlap);
}
