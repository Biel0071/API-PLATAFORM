import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
  skills: string[];
  model: string;
  systemPrompt: string;
  status: 'idle' | 'working' | 'error' | 'offline';
  tasksCompleted: number;
  tasksFailed: number;
  lastActiveAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentsService {
  private static instance: AgentsService;
  private agents: Map<string, AgentDefinition> = new Map();

  private constructor() {
    this.seedDefaultAgents();
  }

  public static getInstance(): AgentsService {
    if (!AgentsService.instance) {
      AgentsService.instance = new AgentsService();
    }
    return AgentsService.instance;
  }

  private seedDefaultAgents(): void {
    const now = new Date().toISOString();
    const defaultAgents: AgentDefinition[] = [
      {
        id: 'executive-brain',
        name: 'Executive Brain',
        role: 'Orchestrator & Strategist',
        description: 'Núcleo de decisão autônoma do FÊNIX OS. Decompõe objetivos, avalia gates comportamentais e planeja missões.',
        capabilities: ['planning', 'reflection', 'gating', 'decision_making'],
        skills: ['mission_planner', 'behavioral_gate', 'decision_recorder'],
        model: 'llama-3.3-70b-versatile',
        systemPrompt: 'Você é o Executive Brain do FÊNIX OS. Pense estrategicamente, nunca assuma sem evidência e valide cada passo.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'architect-agent',
        name: 'Software Architect',
        role: 'System Architect',
        description: 'Mapeia componentes, modela esquemas de dados, desenha interfaces e mantém o Knowledge Graph unificado.',
        capabilities: ['architecture_design', 'knowledge_graph', 'schema_modeling'],
        skills: ['knowledge_graph_query', 'project_mirror_indexer', 'schema_validator'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Você é o Arquiteto de Software. Mantenha alta coesão, baixo acoplamento e contratos de API estáveis.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'coder-agent',
        name: 'Core Coder',
        role: 'Senior Software Engineer',
        description: 'Executa alterações de código seguras em worktrees isolados, aplica patches limpos e refatora com precisão.',
        capabilities: ['code_generation', 'patch_application', 'refactoring'],
        skills: ['file_editor', 'ast_patcher', 'git_worktree'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Você é o Coder Agent. Escreva código limpo, tipado, modular e com tratamento de erro defensivo.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'qa-engineer',
        name: 'Browser & Chaos QA',
        role: 'Quality Assurance Specialist',
        description: 'Executa baterias Playwright, validação visual/layout gate, detecção de regressão e flood stress tests.',
        capabilities: ['browser_automation', 'e2e_testing', 'stress_testing', 'chaos_testing'],
        skills: ['playwright_runner', 'layout_reality_gate', 'api_flood_tester'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Você é o QA Specialist. Ataque pontos cegos, execute testes reais e insira anomalias no TODO-BUGS.md.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'security-auditor',
        name: 'Security & Integrity Auditor',
        role: 'Cybersecurity Engineer',
        description: 'Varre segredos em payloads, previne vazamentos de tokens, valida escopos de chaves e sanitiza I/O.',
        capabilities: ['secret_detection', 'vulnerability_audit', 'scope_verification'],
        skills: ['secret_scanner', 'permission_checker', 'safe_json_validator'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Você é o Security Auditor. Garanta sigilo de credenciais, blindagem contra injeção e isolamento multi-tenant.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'repo-intel',
        name: 'Repo Intel & Mirror Agent',
        role: 'Repository Intelligence Specialist',
        description: 'Indexa repositórios automaticamente, descobre rotas, schemas, frameworks e cataloga pendências técnicas.',
        capabilities: ['ast_traversal', 'route_discovery', 'tech_stack_identification'],
        skills: ['project_mirror_indexer', 'todo_extractor', 'endpoint_finder'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Você é o Repo Intel Agent. Analise o repositório sem preconceitos e produza o raio-X completo do código.',
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];

    for (const agent of defaultAgents) {
      this.agents.set(agent.id, agent);
    }
  }

  public listAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  public getAgent(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  public registerAgent(data: Omit<AgentDefinition, 'id' | 'status' | 'tasksCompleted' | 'tasksFailed' | 'createdAt' | 'updatedAt'> & { id?: string }): AgentDefinition {
    const id = data.id || `agent_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const agent: AgentDefinition = {
      ...data,
      id,
      status: 'idle',
      tasksCompleted: 0,
      tasksFailed: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(id, agent);
    eventBus.emitEvent('agent:registered', 'agents_service', { agentId: id, name: agent.name });
    return agent;
  }

  public updateStatus(id: string, status: AgentDefinition['status']): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    agent.status = status;
    agent.updatedAt = new Date().toISOString();
    if (status === 'working') {
      agent.lastActiveAt = agent.updatedAt;
    }
    eventBus.emitEvent('agent:status_changed', 'agents_service', { agentId: id, status });
    return true;
  }

  public recordTaskResult(id: string, success: boolean): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (success) {
      agent.tasksCompleted++;
    } else {
      agent.tasksFailed++;
    }
    agent.status = 'idle';
    agent.updatedAt = new Date().toISOString();
  }
}

export const agentsService = AgentsService.getInstance();
