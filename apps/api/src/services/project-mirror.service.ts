import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { knowledgeGraphService } from './knowledge-graph.service';
import { logger } from '../lib/logger';

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  file: string;
  lineNumber?: number;
}

export interface DiscoveredModel {
  name: string;
  fields: string[];
  file: string;
}

export interface DiscoveredComponent {
  name: string;
  file: string;
  type: 'react' | 'html' | 'vue' | 'svelte' | 'vanilla';
}

export interface TechnicalDebtItem {
  type: 'TODO' | 'FIXME' | 'BUG' | 'HACK' | 'DEPRECATED';
  file: string;
  lineNumber: number;
  content: string;
}

export interface ProjectMirrorReport {
  id: string;
  name: string;
  repoPath: string;
  indexedAt: string;
  fileCount: number;
  totalSizeBytes: number;
  technologies: string[];
  endpoints: DiscoveredEndpoint[];
  models: DiscoveredModel[];
  components: DiscoveredComponent[];
  technicalDebt: TechnicalDebtItem[];
  treeSummary: {
    directories: number;
    files: number;
    extensions: Record<string, number>;
  };
}

export class ProjectMirrorService {
  private static instance: ProjectMirrorService;
  private mirrors: Map<string, ProjectMirrorReport> = new Map();

  private constructor() {
    this.seedInitialMirrors();
  }

  public static getInstance(): ProjectMirrorService {
    if (!ProjectMirrorService.instance) {
      ProjectMirrorService.instance = new ProjectMirrorService();
    }
    return ProjectMirrorService.instance;
  }

  private seedInitialMirrors(): void {
    const now = new Date().toISOString();
    const defaultApiRoot = process.env.API_WORKSPACE_ROOT || path.resolve(__dirname, '../../../..');
    const resolvedPath = fs.existsSync(defaultApiRoot) ? defaultApiRoot : (fs.existsSync('c:\\Users\\Dell\\Documents\\API GRATIS') ? 'c:\\Users\\Dell\\Documents\\API GRATIS' : process.cwd());
    const selfMirror: ProjectMirrorReport = {
      id: 'mirror_api_platform',
      name: 'API Platform Enterprise',
      repoPath: resolvedPath,
      indexedAt: now,
      fileCount: 148,
      totalSizeBytes: 12_450_000,
      technologies: ['Fastify 5', 'Prisma ORM', 'PostgreSQL', 'Redis', 'BullMQ', 'TypeScript', 'Zod', 'Vitest', 'Playwright', 'Docker'],
      endpoints: [
        { method: 'GET', path: '/v1/health', file: 'apps/api/src/app.ts' },
        { method: 'POST', path: '/v1/chat', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'POST', path: '/v1/text', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'GET', path: '/v1/jobs/:id', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'POST', path: '/v1/mission', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'GET', path: '/v1/models', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'GET', path: '/v1/providers', file: 'apps/api/src/routes/v1/index.ts' },
        { method: 'POST', path: '/admin/login', file: 'apps/api/src/routes/admin/index.ts' },
      ],
      models: [
        { name: 'Tenant', fields: ['id', 'name', 'slug', 'active'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'Project', fields: ['id', 'tenantId', 'name', 'domain'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'User', fields: ['id', 'email', 'role', 'passwordHash'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'ApiKey', fields: ['id', 'keyHash', 'prefix', 'scopes'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'Job', fields: ['id', 'queue', 'status', 'payload', 'result'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'RequestLog', fields: ['id', 'provider', 'model', 'durationMs', 'cost'], file: 'apps/api/prisma/schema.prisma' },
        { name: 'ExecutionMemory', fields: ['id', 'scopeKey', 'queue', 'provider', 'model'], file: 'apps/api/prisma/schema.prisma' },
      ],
      components: [
        { name: 'DashboardShell', file: 'apps/dashboard/public/index.html', type: 'vanilla' },
        { name: 'MissionViewer', file: 'apps/dashboard/public/app.js', type: 'vanilla' },
        { name: 'Playground', file: 'apps/dashboard/public/app.js', type: 'vanilla' },
        { name: 'Wizard', file: 'apps/dashboard/public/app.js', type: 'vanilla' },
      ],
      technicalDebt: [
        { type: 'TODO', file: 'TODO-BUGS.md', lineNumber: 8, content: 'Fila de QA ativa' },
      ],
      treeSummary: {
        directories: 24,
        files: 148,
        extensions: { ts: 64, js: 28, json: 14, md: 22, css: 4, html: 2, prisma: 1 },
      },
    };
    this.mirrors.set(selfMirror.id, selfMirror);
  }

  public listMirrors(): ProjectMirrorReport[] {
    return Array.from(this.mirrors.values());
  }

  public getMirror(id: string): ProjectMirrorReport | undefined {
    return this.mirrors.get(id);
  }

  public async indexRepository(repoPath: string, name: string): Promise<ProjectMirrorReport> {
    const id = `mirror_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    eventBus.emitEvent('mirror:started', 'project_mirror', { id, name, repoPath });

    const technologies = new Set<string>();
    const endpoints: DiscoveredEndpoint[] = [];
    const models: DiscoveredModel[] = [];
    const components: DiscoveredComponent[] = [];
    const technicalDebt: TechnicalDebtItem[] = [];
    const extensions: Record<string, number> = {};
    let fileCount = 0;
    let totalSizeBytes = 0;
    let directoryCount = 0;

    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.data', '.secrets', 'temp_backup', 'archive']);

    async function walk(dir: string, depth: number = 0): Promise<void> {
      if (depth > 6) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      directoryCount++;

      for (const entry of entries) {
        if (ignoreDirs.has(entry)) continue;
        const fullPath = path.join(dir, entry);
        let s;
        try {
          s = await stat(fullPath);
        } catch {
          continue;
        }

        if (s.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (s.isFile()) {
          fileCount++;
          totalSizeBytes += s.size;
          const ext = path.extname(entry).replace(/^\./, '').toLowerCase() || 'none';
          extensions[ext] = (extensions[ext] || 0) + 1;

          // Technology detection from filename
          if (entry === 'package.json') technologies.add('Node.js');
          if (entry === 'tsconfig.json') technologies.add('TypeScript');
          if (entry === 'Dockerfile' || entry.endsWith('.Dockerfile')) technologies.add('Docker');
          if (entry.includes('docker-compose')) technologies.add('Docker Compose');
          if (entry === 'schema.prisma') technologies.add('Prisma ORM');
          if (entry === 'playwright.config.ts' || entry.includes('playwright')) technologies.add('Playwright');
          if (entry === 'vitest.config.ts' || entry.includes('vitest')) technologies.add('Vitest');
          if (entry.endsWith('.py')) technologies.add('Python');

          // Deep scanning for source files under 100KB
          if (['ts', 'js', 'mjs', 'json', 'prisma', 'html', 'vue', 'svelte'].includes(ext) && s.size < 100_000) {
            try {
              const content = await readFile(fullPath, 'utf8');
              const relPath = path.relative(repoPath, fullPath).replace(/\\/g, '/');

              // Detect technologies in package.json
              if (entry === 'package.json') {
                try {
                  const pkg = JSON.parse(content);
                  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
                  if (allDeps['fastify']) technologies.add('Fastify');
                  if (allDeps['express']) technologies.add('Express');
                  if (allDeps['bullmq']) technologies.add('BullMQ');
                  if (allDeps['ioredis'] || allDeps['redis']) technologies.add('Redis');
                  if (allDeps['pg']) technologies.add('PostgreSQL');
                  if (allDeps['react']) technologies.add('React');
                  if (allDeps['zod']) technologies.add('Zod');
                } catch { /* ignore */ }
              }

              // Route & Endpoint detection
              const routeRegex = /(?:app|router|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
              let match;
              while ((match = routeRegex.exec(content)) !== null) {
                endpoints.push({
                  method: match[1].toUpperCase(),
                  path: match[2],
                  file: relPath,
                });
              }

              // Prisma Model detection
              if (ext === 'prisma') {
                const modelRegex = /model\s+([A-Za-z0-9_]+)\s*\{([^}]+)\}/g;
                let mMatch;
                while ((mMatch = modelRegex.exec(content)) !== null) {
                  const modelName = mMatch[1];
                  const body = mMatch[2];
                  const fields = body.split('\n')
                    .map((l) => l.trim().split(/\s+/)[0])
                    .filter((f) => f && !f.startsWith('//') && !f.startsWith('@@'));
                  models.push({
                    name: modelName,
                    fields: fields.slice(0, 10),
                    file: relPath,
                  });
                }
              }

              // UI Component detection
              if (['tsx', 'jsx', 'vue', 'svelte'].includes(ext) || (ext === 'html' && entry.includes('index'))) {
                components.push({
                  name: path.basename(entry, path.extname(entry)),
                  file: relPath,
                  type: ext === 'vue' ? 'vue' : ext === 'svelte' ? 'svelte' : ext === 'html' ? 'html' : 'react',
                });
              }

              // Technical Debt & TODO scanning
              const lines = content.split('\n');
              for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx];
                const debtMatch = /\b(TODO|FIXME|BUG|HACK|DEPRECATED)\b[:\s]*(.*)/i.exec(line);
                if (debtMatch && technicalDebt.length < 50) {
                  technicalDebt.push({
                    type: debtMatch[1].toUpperCase() as TechnicalDebtItem['type'],
                    file: relPath,
                    lineNumber: lineIdx + 1,
                    content: debtMatch[2].trim().slice(0, 120),
                  });
                }
              }
            } catch { /* ignore read errors */ }
          }
        }
      }
    }

    try {
      await walk(repoPath);
    } catch (err) {
      logger.error({ err, repoPath }, 'ProjectMirrorService: walk error');
    }

    const report: ProjectMirrorReport = {
      id,
      name,
      repoPath,
      indexedAt: now,
      fileCount,
      totalSizeBytes,
      technologies: Array.from(technologies),
      endpoints: endpoints.slice(0, 100),
      models: models.slice(0, 50),
      components: components.slice(0, 50),
      technicalDebt: technicalDebt.slice(0, 50),
      treeSummary: {
        directories: directoryCount,
        files: fileCount,
        extensions,
      },
    };

    this.mirrors.set(id, report);

    // Feed Knowledge Graph with project nodes and discovered endpoints
    const projectNodeId = `proj:${name.toLowerCase().replace(/\s+/g, '-')}`;
    knowledgeGraphService.addNode({
      id: projectNodeId,
      type: 'project',
      label: name,
      metadata: { path: repoPath, fileCount, technologies: report.technologies },
    });

    for (const ep of report.endpoints.slice(0, 20)) {
      const epNodeId = `api:${ep.method.toLowerCase()}:${ep.path.replace(/\//g, '_')}`;
      knowledgeGraphService.addNode({
        id: epNodeId,
        type: 'api',
        label: `${ep.method} ${ep.path}`,
        projectId: projectNodeId,
        metadata: { method: ep.method, path: ep.path, file: ep.file },
      });
      knowledgeGraphService.addEdge(projectNodeId, epNodeId, 'implements');
    }

    for (const model of report.models.slice(0, 15)) {
      const modelNodeId = `model:${name.toLowerCase()}:${model.name.toLowerCase()}`;
      knowledgeGraphService.addNode({
        id: modelNodeId,
        type: 'database',
        label: `Model ${model.name}`,
        projectId: projectNodeId,
        metadata: { name: model.name, fields: model.fields, file: model.file },
      });
      knowledgeGraphService.addEdge(projectNodeId, modelNodeId, 'writes_to');
    }

    eventBus.emitEvent('mirror:completed', 'project_mirror', {
      id,
      name,
      technologies: report.technologies,
      endpointCount: report.endpoints.length,
      modelCount: report.models.length,
      debtCount: report.technicalDebt.length,
    });

    return report;
  }
}

export const projectMirrorService = ProjectMirrorService.getInstance();
