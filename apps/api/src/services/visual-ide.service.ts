import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  extension?: string;
}

export class VisualIDEService {
  private static instance: VisualIDEService;

  private allowedRoots: string[] = [
    path.resolve('c:/Users/Dell/Documents/API GRATIS').toLowerCase(),
    path.resolve('C:/projetos/ai-engine-core/ai-engine/grg').toLowerCase(),
    path.resolve(process.cwd()).toLowerCase(),
    path.resolve(__dirname, '../../../..').toLowerCase(),
    '/app',
  ];

  private constructor() {}

  public static getInstance(): VisualIDEService {
    if (!VisualIDEService.instance) {
      VisualIDEService.instance = new VisualIDEService();
    }
    return VisualIDEService.instance;
  }

  public assertPathSafe(targetPath: string): string {
    if (process.platform !== 'win32' && /^[a-zA-Z]:[/\\]/.test(targetPath)) {
      throw new Error(`Acesso negado: o caminho "${targetPath}" está fora dos workspaces autorizados.`);
    }
    const resolved = path.resolve(targetPath);
    const lower = resolved.toLowerCase();
    const isAllowed = this.allowedRoots.some(
      (root) => lower === root || lower.startsWith(root + path.sep) || lower.startsWith(root + '/')
    );
    if (!isAllowed) {
      throw new Error(`Acesso negado: o caminho "${targetPath}" está fora dos workspaces autorizados.`);
    }
    return resolved;
  }

  public async listFiles(baseDir: string, maxDepth: number = 2): Promise<WorkspaceFile[]> {
    this.assertPathSafe(baseDir);
    const results: WorkspaceFile[] = [];
    const ignore = new Set(['node_modules', '.git', 'dist', 'build', '.data', '.secrets', 'coverage']);

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (ignore.has(entry)) continue;
        const full = path.join(dir, entry);
        let s;
        try {
          s = await stat(full);
        } catch {
          continue;
        }

        if (s.isDirectory()) {
          results.push({ name: entry, path: full.replace(/\\/g, '/'), type: 'directory' });
          await walk(full, depth + 1);
        } else if (s.isFile()) {
          results.push({
            name: entry,
            path: full.replace(/\\/g, '/'),
            type: 'file',
            sizeBytes: s.size,
            extension: path.extname(entry).replace(/^\./, ''),
          });
        }
      }
    }

    await walk(baseDir, 0);
    return results;
  }

  public async readFileContent(filePath: string, startLine?: number, endLine?: number): Promise<{ content: string; totalLines: number; range: [number, number] }> {
    const safePath = this.assertPathSafe(filePath);
    const raw = await readFile(safePath, 'utf8');
    const lines = raw.split('\n');
    const totalLines = lines.length;

    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, endLine ?? Math.min(start + 500, totalLines));
    const slice = lines.slice(start - 1, end).join('\n');

    return {
      content: slice,
      totalLines,
      range: [start, end],
    };
  }

  public async applyPatch(
    filePath: string,
    targetContent: string,
    replacementContent: string,
  ): Promise<{ success: boolean; filePath: string; linesChanged: number }> {
    const safePath = this.assertPathSafe(filePath);
    const original = await readFile(safePath, 'utf8');

    if (!original.includes(targetContent)) {
      throw new Error(`Bloco alvo não encontrado em ${filePath}`);
    }
    const occurrences = original.split(targetContent).length - 1;
    if (occurrences > 1) {
      throw new Error(`Bloco alvo é ambíguo (${occurrences} ocorrências encontradas) em ${filePath}`);
    }

    const { writeFile } = await import('node:fs/promises');
    const updated = original.replace(targetContent, replacementContent);
    await writeFile(safePath, updated, 'utf8');
    const linesChanged = Math.abs(replacementContent.split('\n').length - targetContent.split('\n').length);
    eventBus.emitEvent('ide:file_patched', 'visual_ide', { filePath: safePath, linesChanged });
    return { success: true, filePath: safePath, linesChanged };
  }

  public async writeFileContent(
    filePath: string,
    content: string,
  ): Promise<{ success: boolean; filePath: string; sizeBytes: number }> {
    const safePath = this.assertPathSafe(filePath);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(safePath, content, 'utf8');
    const sizeBytes = Buffer.byteLength(content);
    eventBus.emitEvent('ide:file_saved', 'visual_ide', { filePath: safePath, sizeBytes });
    return { success: true, filePath: safePath, sizeBytes };
  }
}

export const visualIDEService = VisualIDEService.getInstance();
