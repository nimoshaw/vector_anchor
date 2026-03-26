// src/chunker.ts
// Unified chunker: Markdown-aware + plain text, auto-selected by file extension

export interface Chunk {
  content: string;
  heading: string;
  startLine: number;
  endLine: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Markdown chunker: splits by heading hierarchy
// ═══════════════════════════════════════════════════════════════════════════

interface HeadingNode { level: number; text: string; }

export function chunkMarkdown(content: string, maxSize = 512, overlap = 64): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  const headingStack: HeadingNode[] = [];
  let currentContent: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      if (currentContent.length > 0) {
        const text = currentContent.join('\n').trim();
        if (text.length > 0) {
          const heading = headingStack.map(h => h.text).join(' > ');
          chunks.push(...splitLong(text, heading, currentStart, i, maxSize, overlap));
        }
      }
      const level = match[1].length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: match[2].trim() });
      currentContent = [line];
      currentStart = i + 1;
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    const text = currentContent.join('\n').trim();
    if (text.length > 0) {
      const heading = headingStack.map(h => h.text).join(' > ');
      chunks.push(...splitLong(text, heading, currentStart, lines.length, maxSize, overlap));
    }
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// Plain text chunker: sliding window with overlap
// ═══════════════════════════════════════════════════════════════════════════

export function chunkText(content: string, maxSize = 512, overlap = 64): Chunk[] {
  if (content.trim().length === 0) return [];

  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let current = '';
  let currentStart = 1;
  let currentLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current.length + line.length + 1 > maxSize && current.length > 0) {
      chunks.push({ content: current.trim(), heading: '', startLine: currentStart, endLine: currentLine });
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n' + line;
      currentStart = Math.max(1, currentLine - overlapText.split('\n').length);
      currentLine = i + 2;
    } else {
      current += (current ? '\n' : '') + line;
      currentLine = i + 2;
    }
  }
  if (current.trim().length > 0) {
    chunks.push({ content: current.trim(), heading: '', startLine: currentStart, endLine: lines.length });
  }
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-select chunker by extension
// ═══════════════════════════════════════════════════════════════════════════

const MD_EXTS = new Set(['.md', '.mdx', '.markdown']);

export function chunkFile(content: string, ext: string, maxSize = 512, overlap = 64): Chunk[] {
  return MD_EXTS.has(ext.toLowerCase())
    ? chunkMarkdown(content, maxSize, overlap)
    : chunkText(content, maxSize, overlap);
}

// ─── Shared helper ─────────────────────────────────────────────────────────

function splitLong(text: string, heading: string, startLine: number, endLine: number, maxSize: number, overlap: number): Chunk[] {
  if (text.length <= maxSize) return [{ content: text, heading, startLine, endLine }];

  const paragraphs = text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let current = '';
  let chunkStart = startLine;
  let lineOffset = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize && current.length > 0) {
      chunks.push({ content: current.trim(), heading, startLine: chunkStart, endLine: chunkStart + lineOffset });
      current = current.slice(-overlap) + '\n\n' + para;
      chunkStart = chunkStart + lineOffset;
      lineOffset = para.split('\n').length;
    } else {
      current += (current ? '\n\n' : '') + para;
      lineOffset += para.split('\n').length;
    }
  }
  if (current.trim().length > 0) {
    chunks.push({ content: current.trim(), heading, startLine: chunkStart, endLine });
  }
  return chunks;
}
