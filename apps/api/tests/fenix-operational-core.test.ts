import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { missionsService } from '../src/services/missions.service';
import { agentsService } from '../src/services/agents.service';
import { skillsService } from '../src/services/skills.service';
import { eventBus } from '../src/services/event-bus.service';
import { operationalMemoryService } from '../src/services/operational-memory.service';
import { knowledgeGraphService } from '../src/services/knowledge-graph.service';
import { multiRepoService } from '../src/services/multi-repo.service';
import { projectMirrorService } from '../src/services/project-mirror.service';
import { centralMonitoringService } from '../src/services/central-monitoring.service';
import { visualIDEService } from '../src/services/visual-ide.service';
import { browserQAService } from '../src/services/browser-qa.service';

describe('FENIX OS Operational Core Services', () => {
  describe('MissionsService', () => {
    it('creates, tracks steps, and completes a mission', () => {
      const mission = missionsService.createMission({
        title: 'Refatoração do Módulo de Autenticação',
        objective: 'Elevar a segurança e auditar escopos de chaves',
        priority: 8,
        agentId: 'executive-brain',
      });
      expect(mission.id).toBeDefined();
      expect(mission.status).toBe('pending');

      const step = missionsService.addStep(mission.id, 'Auditar escopos em prisma/schema.prisma', 'file_inspect');
      expect(step).toBeDefined();
      expect(step?.stepNumber).toBe(1);

      const stepUpdated = missionsService.updateStep(mission.id, step!.id, {
        status: 'completed',
        result: { scopesValid: true },
        durationMs: 450,
      });
      expect(stepUpdated).toBe(true);

      const completed = missionsService.completeMission(mission.id, { allStepsPassed: true }, { prompt: 120, completion: 80 });
      expect(completed).toBe(true);

      const retrieved = missionsService.getMission(mission.id);
      expect(retrieved?.status).toBe('completed');
      expect(retrieved?.tokens.total).toBe(200);
      expect(retrieved?.steps[0].status).toBe('completed');
    });

    it('cancels a running mission and updates agent status', () => {
      const mission = missionsService.createMission({
        title: 'Missão Experimental Cancelável',
        objective: 'Testar interrupção graciosa',
        autoStart: true,
        agentId: 'coder-agent',
      });
      expect(mission.status).toBe('in_progress');

      const cancelled = missionsService.cancelMission(mission.id);
      expect(cancelled).toBe(true);
      expect(missionsService.getMission(mission.id)?.status).toBe('cancelled');
    });
  });

  describe('AgentsService', () => {
    it('lists core built-in agents for FENIX OS', () => {
      const agents = agentsService.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(6);
      const brain = agents.find((a) => a.id === 'executive-brain');
      expect(brain).toBeDefined();
      expect(brain?.role).toContain('Orchestrator');
      expect(brain?.capabilities).toContain('planning');

      const qa = agents.find((a) => a.id === 'qa-engineer');
      expect(qa).toBeDefined();
      expect(qa?.skills).toContain('playwright_runner');
    });

    it('registers a custom agent and updates status', () => {
      const custom = agentsService.registerAgent({
        name: 'Performance Profiler',
        role: 'APM Specialist',
        description: 'Mede throughput e alocação de heap',
        capabilities: ['profiling', 'benchmarking'],
        skills: ['flamegraph', 'heap_analyzer'],
        model: 'qwen2.5:latest',
        systemPrompt: 'Monitore memory leaks rigorosamente.',
      });
      expect(custom.id).toBeDefined();
      expect(custom.status).toBe('idle');

      agentsService.updateStatus(custom.id, 'working');
      expect(agentsService.getAgent(custom.id)?.status).toBe('working');

      agentsService.recordTaskResult(custom.id, true);
      const after = agentsService.getAgent(custom.id);
      expect(after?.status).toBe('idle');
      expect(after?.tasksCompleted).toBe(1);
    });
  });

  describe('SkillsService', () => {
    it('contains essential software engineering skills', () => {
      const skills = skillsService.listSkills();
      expect(skills.length).toBeGreaterThanOrEqual(8);
      const skillNames = skills.map((s) => s.name);
      expect(skillNames).toContain('code_search');
      expect(skillNames).toContain('file_inspect');
      expect(skillNames).toContain('file_patch');
      expect(skillNames).toContain('test_runner');
      expect(skillNames).toContain('decision_recorder');
      expect(skillNames).toContain('error_resolver');
      expect(skillNames).toContain('knowledge_graph_query');
    });

    it('executes decision_recorder skill and stores in operational memory', async () => {
      const result = await skillsService.executeSkill('decision_recorder', {
        title: 'Migração de Engine de Busca',
        context: 'Necessidade de busca full-text no Knowledge Graph',
        chosenOption: 'In-memory inverted index com ranking semântico',
        rationale: 'Latência submilisegundo sem sobrecarga externa',
      });
      expect(result.success).toBe(true);
      expect((result.result as any).id).toBeDefined();
    });

    it('returns error when executing an unregistered skill', async () => {
      const result = await skillsService.executeSkill('non_existent_skill', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('não encontrada');
    });
  });

  describe('OperationalMemoryService', () => {
    it('records decisions and retrieves them with search', () => {
      const dec = operationalMemoryService.recordDecision({
        title: 'Isolamento de Worktrees Git para o Coder Agent',
        context: 'Evitar colisões de arquivos em missões paralelas',
        alternatives: ['Usar a mesma pasta', 'Criar worktrees temporários isolados'],
        chosenOption: 'Criar worktrees temporários isolados',
        rationale: 'Permite rollback atômico sem impactar a branch principal',
        author: 'ExecutiveBrain',
        tags: ['git', 'worktree', 'safety'],
      });
      expect(dec.id).toBeDefined();

      const search = operationalMemoryService.searchMemory('worktree');
      expect(search.decisions.length).toBeGreaterThanOrEqual(1);
      expect(search.decisions.some((d) => d.title.includes('Worktrees'))).toBe(true);
    });

    it('records error resolution and matches known errors to avoid regressions', () => {
      const resolution = operationalMemoryService.recordErrorResolution({
        errorType: 'DATABASE_DEADLOCK',
        errorMessage: 'Deadlock detected during concurrent tenant job updates',
        rootCause: 'Ordem inconsistente de locks nas tabelas Job e RequestLog',
        resolutionApplied: 'Ordenação canônica de IDs antes de executar batch updates',
        filesChanged: ['apps/api/src/services/queue.service.ts'],
        regressionTest: 'tests/queue.test.ts',
        verified: true,
      });
      expect(resolution.id).toBeDefined();

      const found = operationalMemoryService.findResolutionForError('Deadlock detected during concurrent tenant job updates');
      expect(found).toBeDefined();
      expect(found?.rootCause).toContain('Ordem inconsistente');
    });
  });

  describe('KnowledgeGraphService', () => {
    it('seeds and queries multidimensional graph nodes and edges', () => {
      const stats = knowledgeGraphService.getStats();
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.totalEdges).toBeGreaterThan(0);

      // Add a custom node
      const node = knowledgeGraphService.addNode({
        type: 'function',
        label: 'executeSynchronousQuality()',
        metadata: { purity: true, complexity: 'O(1)' },
      });
      expect(node.id).toBeDefined();

      // Add edge connecting to project
      const edge = knowledgeGraphService.addEdge('proj:api-platform', node.id, 'implements');
      expect(edge.id).toBeDefined();

      // Query neighbors
      const neighbors = knowledgeGraphService.getNeighbors('proj:api-platform');
      expect(neighbors.some((n) => n.node.id === node.id)).toBe(true);

      // Subgraph retrieval
      const subgraph = knowledgeGraphService.getSubgraph('proj:api-platform', 1);
      expect(subgraph.nodes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('MultiRepoService', () => {
    it('manages connected repositories, sync status, and issues', () => {
      const repos = multiRepoService.listRepositories();
      expect(repos.length).toBeGreaterThanOrEqual(2);

      const apiRepo = repos.find((r) => r.id === 'repo_api_platform');
      expect(apiRepo).toBeDefined();
      expect(['synced', 'diverged']).toContain(apiRepo?.status);
      expect(apiRepo?.branches[0].name).toBe('main');

      const synced = multiRepoService.syncRepository('repo_api_platform');
      expect(['synced', 'diverged']).toContain(synced?.status);
      expect(synced?.branches[0].latestCommitHash).toBeDefined();

      const issue = multiRepoService.addIssue('repo_api_platform', {
        title: 'Verificar telemetria sob alta concorrência de BullMQ',
        priority: 'high',
        assignee: 'CoderAgent',
      });
      expect(issue?.id).toBeDefined();
      expect(issue?.title).toContain('Verificar telemetria');
    });
  });

  describe('VisualIDEService', () => {
    it('lists files and reads file content within allowed project directory', async () => {
      const testDir = path.resolve(__dirname, '..');
      const files = await visualIDEService.listFiles(testDir, 1);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.name === 'package.json')).toBe(true);

      const content = await visualIDEService.readFileContent(path.join(testDir, 'package.json'), 1, 5);
      expect(content.content).toContain('api');
      expect(content.totalLines).toBeGreaterThan(5);
    });

    it('rejects file access outside authorized workspaces', async () => {
      const unauthorized = process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/shadow';
      await expect(visualIDEService.readFileContent(unauthorized)).rejects.toThrow('Acesso negado');
    });
  });

  describe('BrowserQAService', () => {
    it('records and lists QA test runs', () => {
      const run = browserQAService.recordRun({
        scenario: 'E2E Health and Gateway Inspection',
        targetUrl: 'http://localhost:3000/v1/health',
        status: 'passed',
        durationMs: 120,
        viewport: { width: 1280, height: 720 },
        stepsExecuted: 3,
        uiErrors: [],
        screenshots: [],
      });
      expect(run.id).toBeDefined();
      expect(run.status).toBe('passed');

      const runs = browserQAService.listRuns();
      expect(runs.some((r) => r.id === run.id)).toBe(true);
    });
  });

  describe('EventBusService', () => {
    it('emits events and keeps bounded history with filtering', () => {
      let receivedEvent: any = null;
      const listener = (e: any) => { receivedEvent = e; };
      eventBus.once('event:test:ping', listener);

      const event = eventBus.emitEvent('test:ping', 'unit_test', { payload: 42 }, { severity: 'info' });
      expect(event.id).toBeDefined();
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent.data.payload).toBe(42);

      const history = eventBus.getHistory({ type: 'test:ping' });
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('CentralMonitoringService', () => {
    it('returns complete dashboard telemetry payload without crashing', async () => {
      const dashboard = await centralMonitoringService.getDashboardData();
      expect(dashboard.system.status).toBe('ONLINE');
      expect(dashboard.system.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(dashboard.system.memory.totalMb).toBeGreaterThan(0);
      expect(dashboard.missions.total).toBeGreaterThanOrEqual(1);
      expect(dashboard.agents.total).toBeGreaterThanOrEqual(6);
      expect(dashboard.repositories.total).toBeGreaterThanOrEqual(2);
      expect(dashboard.aiUsage).toBeDefined();
      expect(Array.isArray(dashboard.recentEvents)).toBe(true);
    }, 15000);
  });
});
