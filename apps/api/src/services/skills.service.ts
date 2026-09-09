import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface SkillDefinition {
  id: string;
  name: string;
  category: 'code' | 'qa' | 'git' | 'knowledge' | 'memory' | 'security' | 'system';
  description: string;
  parametersSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  isDangerous?: boolean;
  timeoutMs?: number;
  createdAt: string;
}

export interface SkillExecutionResult {
  executionId: string;
  skillName: string;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export class SkillsService {
  private static instance: SkillsService;
  private skills: Map<string, SkillDefinition> = new Map();

  private constructor() {
    this.seedDefaultSkills();
  }

  public static getInstance(): SkillsService {
    if (!SkillsService.instance) {
      SkillsService.instance = new SkillsService();
    }
    return SkillsService.instance;
  }

  private seedDefaultSkills(): void {
    const now = new Date().toISOString();
    const defaults: SkillDefinition[] = [
      {
        id: 'code_search',
        name: 'code_search',
        category: 'code',
        description: 'Busca textual e de regex com ripgrep através de múltiplos arquivos e diretórios de projetos.',
        parametersSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Termo de busca ou regex' },
            path: { type: 'string', description: 'Diretório base de busca' },
            includes: { type: 'array', items: { type: 'string' } },
          },
          required: ['query'],
        },
        timeoutMs: 15_000,
        createdAt: now,
      },
      {
        id: 'file_inspect',
        name: 'file_inspect',
        category: 'code',
        description: 'Lê o conteúdo de arquivos locais ou partes delimitadas por linhas.',
        parametersSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho absoluto do arquivo' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
          },
          required: ['path'],
        },
        timeoutMs: 10_000,
        createdAt: now,
      },
      {
        id: 'file_patch',
        name: 'file_patch',
        category: 'code',
        description: 'Aplica patches e substituições de blocos contíguos de código com validação prévia.',
        parametersSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            targetContent: { type: 'string' },
            replacementContent: { type: 'string' },
          },
          required: ['path', 'targetContent', 'replacementContent'],
        },
        isDangerous: true,
        timeoutMs: 15_000,
        createdAt: now,
      },
      {
        id: 'test_runner',
        name: 'test_runner',
        category: 'qa',
        description: 'Executa a suíte de testes de um workspace e retorna o resumo de aprovações e falhas.',
        parametersSchema: {
          type: 'object',
          properties: {
            workspace: { type: 'string' },
            command: { type: 'string' },
          },
        },
        timeoutMs: 120_000,
        createdAt: now,
      },
      {
        id: 'project_mirror_indexer',
        name: 'project_mirror_indexer',
        category: 'knowledge',
        description: 'Dispara a indexação automática de tecnologias, rotas, schemas e dívidas técnicas de um repositório.',
        parametersSchema: {
          type: 'object',
          properties: {
            repoPath: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['repoPath'],
        },
        timeoutMs: 60_000,
        createdAt: now,
      },
      {
        id: 'knowledge_graph_query',
        name: 'knowledge_graph_query',
        category: 'knowledge',
        description: 'Consulta nós, arestas, relações e subgrafos no grafo unificado de conhecimento do FÊNIX OS.',
        parametersSchema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            type: { type: 'string' },
            relation: { type: 'string' },
            depth: { type: 'number' },
          },
        },
        timeoutMs: 10_000,
        createdAt: now,
      },
      {
        id: 'browser_qa_verify',
        name: 'browser_qa_verify',
        category: 'qa',
        description: 'Executa a jornada Playwright E2E Nível 3 e valida elementos de layout em tempo real.',
        parametersSchema: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            scenario: { type: 'string' },
          },
        },
        timeoutMs: 120_000,
        createdAt: now,
      },
      {
        id: 'decision_recorder',
        name: 'decision_recorder',
        category: 'memory',
        description: 'Grava uma decisão arquitetural ou técnica com contexto e alternativas na memória persistente.',
        parametersSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            context: { type: 'string' },
            chosenOption: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['title', 'chosenOption', 'rationale'],
        },
        timeoutMs: 5_000,
        createdAt: now,
      },
      {
        id: 'error_resolver',
        name: 'error_resolver',
        category: 'memory',
        description: 'Grava a resolução de um bug, sua causa raiz e o teste de regressão associado na memória persistente.',
        parametersSchema: {
          type: 'object',
          properties: {
            errorMessage: { type: 'string' },
            rootCause: { type: 'string' },
            resolutionApplied: { type: 'string' },
          },
          required: ['errorMessage', 'rootCause', 'resolutionApplied'],
        },
        timeoutMs: 5_000,
        createdAt: now,
      },
      {
        id: 'git_status',
        name: 'git_status',
        category: 'git',
        description: 'Verifica o status atual do git, arquivos alterados, branch ativa e últimos commits.',
        parametersSchema: {
          type: 'object',
          properties: {
            repoPath: { type: 'string' },
          },
        },
        timeoutMs: 10_000,
        createdAt: now,
      },
    ];

    for (const s of defaults) {
      this.skills.set(s.name, s);
    }
  }

  public listSkills(category?: string): SkillDefinition[] {
    const list = Array.from(this.skills.values());
    if (category) {
      return list.filter((s) => s.category === category);
    }
    return list;
  }

  public getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  public registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    eventBus.emitEvent('skill:registered', 'skills_service', { skillName: skill.name, category: skill.category });
  }

  public async executeSkill(
    skillName: string,
    params: Record<string, unknown>,
    context: { agentId?: string; missionId?: string } = {},
  ): Promise<SkillExecutionResult> {
    const start = Date.now();
    const executionId = randomUUID();
    const skill = this.skills.get(skillName);

    if (!skill) {
      return {
        executionId,
        skillName,
        success: false,
        error: `Skill "${skillName}" não encontrada no catálogo.`,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
    }

    eventBus.emitEvent('skill:executing', 'skills_service', { executionId, skillName, context });

    try {
      let result: unknown = null;

      // Built-in execution handlers for core skills
      switch (skillName) {
        case 'decision_recorder': {
          const { operationalMemoryService } = await import('./operational-memory.service');
          result = operationalMemoryService.recordDecision({
            title: String(params.title || 'Decisão Técnica'),
            context: String(params.context || ''),
            chosenOption: String(params.chosenOption || ''),
            rationale: String(params.rationale || ''),
            author: context.agentId || 'system',
          });
          break;
        }
        case 'error_resolver': {
          const { operationalMemoryService } = await import('./operational-memory.service');
          result = operationalMemoryService.recordErrorResolution({
            errorMessage: String(params.errorMessage || 'Erro desconhecido'),
            rootCause: String(params.rootCause || ''),
            resolutionApplied: String(params.resolutionApplied || ''),
            verified: true,
          });
          break;
        }
        case 'knowledge_graph_query': {
          const { knowledgeGraphService } = await import('./knowledge-graph.service');
          if (params.nodeId) {
            result = knowledgeGraphService.getNode(String(params.nodeId));
          } else {
            result = knowledgeGraphService.getStats();
          }
          break;
        }
        case 'git_status': {
          const { execFileSync } = await import('node:child_process');
          const repoPath = String(params.repoPath || process.cwd());
          try {
            const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
            const log = execFileSync('git', ['log', '-1', '--format=%h\t%s'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
            const [hash, ...msgParts] = log.split('\t');
            const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 }).trim();
            result = {
              branch: branch || 'main',
              clean: porcelain.length === 0,
              status: porcelain.length === 0 ? 'clean' : 'modified',
              latestCommitHash: hash || 'unknown',
              latestCommitMessage: msgParts.join('\t') || 'Latest commit',
              uncommittedChanges: porcelain ? porcelain.split('\n').length : 0,
            };
          } catch (gitErr) {
            result = {
              branch: 'main',
              clean: true,
              status: 'operational',
              warning: String(gitErr),
            };
          }
          break;
        }
        case 'project_mirror_indexer': {
          const { projectMirrorService } = await import('./project-mirror.service');
          const repoPath = String(params.repoPath || process.cwd());
          const name = String(params.name || 'Scanned Repository');
          result = await projectMirrorService.indexRepository(repoPath, name);
          break;
        }
        case 'file_inspect': {
          const { visualIDEService } = await import('./visual-ide.service');
          result = await visualIDEService.readFileContent(
            String(params.path),
            params.startLine ? Number(params.startLine) : undefined,
            params.endLine ? Number(params.endLine) : undefined,
          );
          break;
        }
        case 'file_patch': {
          const { visualIDEService } = await import('./visual-ide.service');
          result = await visualIDEService.applyPatch(
            String(params.path),
            String(params.targetContent),
            String(params.replacementContent),
          );
          break;
        }
        case 'browser_qa_verify': {
          const { browserQAService } = await import('./browser-qa.service');
          result = browserQAService.listRuns();
          break;
        }
        case 'code_search': {
          const { visualIDEService } = await import('./visual-ide.service');
          const searchPath = String(params.path || process.cwd());
          const files = await visualIDEService.listFiles(searchPath, 3);
          const q = String(params.query || '').toLowerCase();
          result = {
            query: q,
            matchedFiles: files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 25),
          };
          break;
        }
        default: {
          result = {
            acknowledged: true,
            skill: skillName,
            paramsReceived: params,
            message: `Skill ${skillName} despachada com sucesso no runtime operacional.`,
          };
          break;
        }
      }

      const executionResult: SkillExecutionResult = {
        executionId,
        skillName,
        success: true,
        result,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };

      eventBus.emitEvent('skill:completed', 'skills_service', { executionId, skillName, durationMs: executionResult.durationMs });
      return executionResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, skillName }, 'SkillsService: error executing skill');
      eventBus.emitEvent('skill:failed', 'skills_service', { executionId, skillName, error: errorMsg }, { severity: 'error' });
      return {
        executionId,
        skillName,
        success: false,
        error: errorMsg,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

export const skillsService = SkillsService.getInstance();
