import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface RepositoryBranch {
  name: string;
  isDefault: boolean;
  latestCommitHash: string;
  latestCommitMessage: string;
  updatedAt: string;
}

export interface RepositoryIssue {
  id: string;
  title: string;
  state: 'open' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee?: string;
  labels?: string[];
  createdAt: string;
}

export interface RepositoryPipeline {
  id: string;
  branch: string;
  status: 'success' | 'failed' | 'running' | 'queued';
  durationMs: number;
  trigger: string;
  runAt: string;
}

export interface ConnectedRepository {
  id: string;
  name: string;
  path: string;
  remoteUrl?: string;
  defaultBranch: string;
  status: 'synced' | 'diverged' | 'offline' | 'cloning';
  branches: RepositoryBranch[];
  issues: RepositoryIssue[];
  pipelines: RepositoryPipeline[];
  lastSyncedAt: string;
  createdAt: string;
}

function readGitRepoMetadata(repoPath: string): { branch: string; commitHash: string; commitMessage: string; isDirty: boolean } | undefined {
  try {
    if (!fs.existsSync(repoPath)) return undefined;
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, encoding: 'utf8', timeout: 3000 }).trim();
    const logOutput = execFileSync('git', ['log', '-1', '--format=%h\t%s'], { cwd: repoPath, encoding: 'utf8', timeout: 3000 }).trim();
    const [commitHash, ...msgParts] = logOutput.split('\t');
    const statusOutput = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8', timeout: 3000 }).trim();
    return {
      branch: branch || 'main',
      commitHash: commitHash || 'head',
      commitMessage: msgParts.join('\t') || 'Latest commit',
      isDirty: statusOutput.length > 0,
    };
  } catch {
    return undefined;
  }
}

export class MultiRepoService {
  private static instance: MultiRepoService;
  private repositories: Map<string, ConnectedRepository> = new Map();

  private constructor() {
    this.seedDefaultRepositories();
  }

  public static getInstance(): MultiRepoService {
    if (!MultiRepoService.instance) {
      MultiRepoService.instance = new MultiRepoService();
    }
    return MultiRepoService.instance;
  }

  private seedDefaultRepositories(): void {
    const now = new Date().toISOString();

    const defaultApiRoot = process.env.API_WORKSPACE_ROOT || path.resolve(__dirname, '../../../..');
    const p1Path = fs.existsSync(defaultApiRoot) ? defaultApiRoot : (fs.existsSync('c:\\Users\\Dell\\Documents\\API GRATIS') ? 'c:\\Users\\Dell\\Documents\\API GRATIS' : process.cwd());
    const p1Meta = readGitRepoMetadata(p1Path);
    const r1: ConnectedRepository = {
      id: 'repo_api_platform',
      name: 'API Platform Enterprise',
      path: p1Path,
      remoteUrl: 'https://github.com/Biel0071/AI-LLM.git',
      defaultBranch: p1Meta?.branch || 'main',
      status: p1Meta?.isDirty ? 'diverged' : 'synced',
      branches: [
        {
          name: p1Meta?.branch || 'main',
          isDefault: true,
          latestCommitHash: p1Meta?.commitHash || 'cf4db74',
          latestCommitMessage: p1Meta?.commitMessage || 'feat: Add multipart file upload, multi-model support, and disk-based processors',
          updatedAt: now,
        },
      ],
      issues: [
        {
          id: 'ISSUE-1',
          title: 'Auditoria de endpoints de inferência e validação E2E Level 3',
          state: 'closed',
          priority: 'high',
          assignee: 'Arquiteto-Chefe',
          labels: ['qa', 'e2e', 'production'],
          createdAt: now,
        },
        {
          id: 'ISSUE-2',
          title: 'Manter latência sob CPU abaixo do timeout de keepalive',
          state: 'closed',
          priority: 'critical',
          assignee: 'Senior Engineer',
          labels: ['performance', 'timeout'],
          createdAt: now,
        },
      ],
      pipelines: [
        {
          id: 'pipe-001',
          branch: p1Meta?.branch || 'main',
          status: 'success',
          durationMs: 42_500,
          trigger: 'push',
          runAt: now,
        },
      ],
      lastSyncedAt: now,
      createdAt: now,
    };
    this.repositories.set(r1.id, r1);

    const p2Path = 'C:\\projetos\\ai-engine-core\\ai-engine\\grg';
    const p2Meta = readGitRepoMetadata(p2Path);
    const r2: ConnectedRepository = {
      id: 'repo_fenix_os',
      name: 'FÊNIX OS Core',
      path: p2Path,
      remoteUrl: 'https://github.com/Biel0071/FENIX-OS.git',
      defaultBranch: p2Meta?.branch || 'main',
      status: p2Meta?.isDirty ? 'diverged' : 'synced',
      branches: [
        {
          name: p2Meta?.branch || 'main',
          isDefault: true,
          latestCommitHash: p2Meta?.commitHash || 'da779f4f',
          latestCommitMessage: p2Meta?.commitMessage || 'verify independent agent desk controls',
          updatedAt: now,
        },
      ],
      issues: [
        {
          id: 'ISSUE-F1',
          title: 'Integração de AI Gateway e polling HTTP 202 com AI Platform',
          state: 'closed',
          priority: 'critical',
          assignee: 'ExecutiveBrain',
          labels: ['aiplatform', 'integration'],
          createdAt: now,
        },
      ],
      pipelines: [
        {
          id: 'pipe-f1',
          branch: p2Meta?.branch || 'main',
          status: 'success',
          durationMs: 125_900,
          trigger: 'npm run test:orchestration',
          runAt: now,
        },
      ],
      lastSyncedAt: now,
      createdAt: now,
    };
    this.repositories.set(r2.id, r2);
  }

  public listRepositories(): ConnectedRepository[] {
    return Array.from(this.repositories.values());
  }

  public getRepository(id: string): ConnectedRepository | undefined {
    return this.repositories.get(id);
  }

  public connectRepository(data: { name: string; path: string; remoteUrl?: string; defaultBranch?: string }): ConnectedRepository {
    const id = `repo_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const repo: ConnectedRepository = {
      id,
      name: data.name,
      path: data.path,
      remoteUrl: data.remoteUrl,
      defaultBranch: data.defaultBranch || 'main',
      status: 'synced',
      branches: [
        {
          name: data.defaultBranch || 'main',
          isDefault: true,
          latestCommitHash: 'head',
          latestCommitMessage: 'Initial sync',
          updatedAt: now,
        },
      ],
      issues: [],
      pipelines: [],
      lastSyncedAt: now,
      createdAt: now,
    };
    this.repositories.set(id, repo);
    eventBus.emitEvent('repo:connected', 'multi_repo', { repoId: id, name: repo.name, path: repo.path });
    return repo;
  }

  public syncRepository(id: string): ConnectedRepository | undefined {
    const repo = this.repositories.get(id);
    if (!repo) return undefined;
    const now = new Date().toISOString();
    repo.lastSyncedAt = now;
    const meta = readGitRepoMetadata(repo.path);
    if (meta) {
      repo.status = meta.isDirty ? 'diverged' : 'synced';
      repo.defaultBranch = meta.branch;
      const defaultBranchObj = repo.branches.find((b) => b.name === meta.branch);
      if (defaultBranchObj) {
        defaultBranchObj.latestCommitHash = meta.commitHash;
        defaultBranchObj.latestCommitMessage = meta.commitMessage;
        defaultBranchObj.updatedAt = now;
      } else {
        repo.branches.unshift({
          name: meta.branch,
          isDefault: true,
          latestCommitHash: meta.commitHash,
          latestCommitMessage: meta.commitMessage,
          updatedAt: now,
        });
      }
    } else {
      repo.status = 'synced';
    }
    eventBus.emitEvent('repo:synced', 'multi_repo', { repoId: id, name: repo.name, status: repo.status });
    return repo;
  }

  public addIssue(repoId: string, issue: Omit<RepositoryIssue, 'id' | 'createdAt'>): RepositoryIssue | undefined {
    const repo = this.repositories.get(repoId);
    if (!repo) return undefined;
    const newIssue: RepositoryIssue = {
      ...issue,
      id: `ISSUE-${repo.issues.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    repo.issues.unshift(newIssue);
    eventBus.emitEvent('repo:issue_created', 'multi_repo', { repoId, issueId: newIssue.id, title: newIssue.title });
    return newIssue;
  }

  public recordPipeline(repoId: string, pipeline: Omit<RepositoryPipeline, 'id' | 'runAt'>): RepositoryPipeline | undefined {
    const repo = this.repositories.get(repoId);
    if (!repo) return undefined;
    const newPipeline: RepositoryPipeline = {
      ...pipeline,
      id: `pipe-${randomUUID().slice(0, 6)}`,
      runAt: new Date().toISOString(),
    };
    repo.pipelines.unshift(newPipeline);
    eventBus.emitEvent('repo:pipeline_finished', 'multi_repo', { repoId, pipelineId: newPipeline.id, status: newPipeline.status });
    return newPipeline;
  }
}

export const multiRepoService = MultiRepoService.getInstance();
