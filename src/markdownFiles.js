import fs from 'node:fs/promises';
import path from 'node:path';
import { isMarkdownPath } from './links.js';
import { createPathFilter } from './pathFilter.js';

/** Markdown files under `rootDir`, as POSIX relative paths, sorted for display. */
export async function listMarkdownFiles(rootDir, filter = createPathFilter()) {
  const files = [];
  await walk(rootDir, '');
  return files.sort((a, b) => a.localeCompare(b));

  async function walk(currentDir, relativeDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (filter.allowsDirectory(relativePath)) await walk(path.join(currentDir, entry.name), relativePath);
      } else if (entry.isFile() && isMarkdownPath(entry.name) && filter.matchesFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }
}
