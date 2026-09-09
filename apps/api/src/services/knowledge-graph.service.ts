import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export type KnowledgeNodeType =
  | 'project'
  | 'file'
  | 'class'
  | 'function'
  | 'api'
  | 'agent'
  | 'skill'
  | 'event'
  | 'workflow'
  | 'database'
  | 'worker';

export type KnowledgeEdgeRelation =
  | 'calls'
  | 'imports'
  | 'implements'
  | 'triggers'
  | 'depends_on'
  | 'reads_from'
  | 'writes_to'
  | 'assigned_to';

export interface KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  label: string;
  projectId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeEdge {
  id: string;
  source: string;
  target: string;
  relation: KnowledgeEdgeRelation;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export class KnowledgeGraphService {
  private static instance: KnowledgeGraphService;
  private nodes: Map<string, KnowledgeNode> = new Map();
  private edges: Map<string, KnowledgeEdge> = new Map();

  private constructor() {
    this.seedInitialGraph();
  }

  public static getInstance(): KnowledgeGraphService {
    if (!KnowledgeGraphService.instance) {
      KnowledgeGraphService.instance = new KnowledgeGraphService();
    }
    return KnowledgeGraphService.instance;
  }

  private seedInitialGraph(): void {
    const now = new Date().toISOString();

    // Project Node
    const p1: KnowledgeNode = {
      id: 'proj:api-platform',
      type: 'project',
      label: 'API Platform Enterprise',
      metadata: { path: 'c:/Users/Dell/Documents/API GRATIS', runtime: 'Fastify + BullMQ + Redis + PostgreSQL' },
      createdAt: now,
    };
    this.nodes.set(p1.id, p1);

    const p2: KnowledgeNode = {
      id: 'proj:fenix-os',
      type: 'project',
      label: 'FÊNIX OS Core',
      metadata: { path: 'C:/projetos/ai-engine-core/ai-engine/grg', runtime: 'Node.js 18 + GRG Services OS' },
      createdAt: now,
    };
    this.nodes.set(p2.id, p2);

    // Database node
    const db1: KnowledgeNode = {
      id: 'db:postgres-primary',
      type: 'database',
      label: 'PostgreSQL Relational DB',
      metadata: { dialect: 'postgresql', schema: 'public', port: 5433 },
      createdAt: now,
    };
    this.nodes.set(db1.id, db1);

    // Worker node
    const w1: KnowledgeNode = {
      id: 'worker:bullmq-primary',
      type: 'worker',
      label: 'BullMQ Queue Processor',
      metadata: { queues: ['text', 'chat', 'vision', 'image', 'embedding', 'mission'], concurrency: 4 },
      createdAt: now,
    };
    this.nodes.set(w1.id, w1);

    // API Nodes
    const apiHealth: KnowledgeNode = {
      id: 'api:v1:health',
      type: 'api',
      label: 'GET /v1/health',
      metadata: { method: 'GET', path: '/v1/health', public: true },
      createdAt: now,
    };
    const apiChat: KnowledgeNode = {
      id: 'api:v1:chat',
      type: 'api',
      label: 'POST /v1/chat',
      metadata: { method: 'POST', path: '/v1/chat', capability: 'chat' },
      createdAt: now,
    };
    const apiJobs: KnowledgeNode = {
      id: 'api:v1:jobs',
      type: 'api',
      label: 'GET /v1/jobs/:id',
      metadata: { method: 'GET', path: '/v1/jobs/:id', asyncContract: true },
      createdAt: now,
    };
    this.nodes.set(apiHealth.id, apiHealth);
    this.nodes.set(apiChat.id, apiChat);
    this.nodes.set(apiJobs.id, apiJobs);

    // Agent Nodes (6 Core FÊNIX Archetypes)
    const agentsList = [
      { id: 'agent:executive-brain', label: 'Executive Brain', role: 'Orchestrator & Strategist' },
      { id: 'agent:architect-agent', label: 'Software Architect', role: 'System Architect' },
      { id: 'agent:coder-agent', label: 'Core Coder', role: 'Senior Software Engineer' },
      { id: 'agent:qa-engineer', label: 'Browser & Chaos QA', role: 'Quality Assurance' },
      { id: 'agent:security-auditor', label: 'Security Auditor', role: 'Cybersecurity Engineer' },
      { id: 'agent:repo-intel', label: 'Repo Intel Agent', role: 'Repository Intelligence' },
    ];
    for (const ag of agentsList) {
      this.nodes.set(ag.id, {
        id: ag.id,
        type: 'agent',
        label: ag.label,
        metadata: { role: ag.role },
        createdAt: now,
      });
    }

    // Skill Nodes (10 Software Engineering Skills)
    const skillsList = [
      { id: 'skill:code_search', label: 'code_search', category: 'code', assignedTo: 'agent:coder-agent' },
      { id: 'skill:file_inspect', label: 'file_inspect', category: 'code', assignedTo: 'agent:coder-agent' },
      { id: 'skill:file_patch', label: 'file_patch', category: 'code', assignedTo: 'agent:coder-agent' },
      { id: 'skill:test_runner', label: 'test_runner', category: 'qa', assignedTo: 'agent:qa-engineer' },
      { id: 'skill:browser_qa_verify', label: 'browser_qa_verify', category: 'qa', assignedTo: 'agent:qa-engineer' },
      { id: 'skill:project_mirror_indexer', label: 'project_mirror_indexer', category: 'knowledge', assignedTo: 'agent:repo-intel' },
      { id: 'skill:knowledge_graph_query', label: 'knowledge_graph_query', category: 'knowledge', assignedTo: 'agent:architect-agent' },
      { id: 'skill:decision_recorder', label: 'decision_recorder', category: 'memory', assignedTo: 'agent:executive-brain' },
      { id: 'skill:error_resolver', label: 'error_resolver', category: 'memory', assignedTo: 'agent:architect-agent' },
      { id: 'skill:git_status', label: 'git_status', category: 'git', assignedTo: 'agent:repo-intel' },
    ];
    for (const sk of skillsList) {
      this.nodes.set(sk.id, {
        id: sk.id,
        type: 'skill',
        label: sk.label,
        metadata: { category: sk.category },
        createdAt: now,
      });
      this.addEdgeInternal(sk.assignedTo, sk.id, 'assigned_to', { category: sk.category }, now);
    }

    // Connect edges
    this.addEdgeInternal('proj:fenix-os', 'proj:api-platform', 'depends_on', { reason: 'core operational gateway' }, now);
    this.addEdgeInternal('proj:api-platform', 'db:postgres-primary', 'writes_to', { orm: 'prisma' }, now);
    this.addEdgeInternal('proj:api-platform', 'worker:bullmq-primary', 'triggers', { bus: 'redis' }, now);
    this.addEdgeInternal('agent:executive-brain', 'api:v1:chat', 'calls', { fallback: true }, now);
    this.addEdgeInternal('agent:executive-brain', 'api:v1:jobs', 'calls', { polling: true }, now);
    this.addEdgeInternal('agent:coder-agent', 'proj:api-platform', 'implements', { worktree: true }, now);
    this.addEdgeInternal('agent:qa-engineer', 'api:v1:health', 'calls', { probe: true }, now);
  }

  private addEdgeInternal(source: string, target: string, relation: KnowledgeEdgeRelation, metadata?: Record<string, unknown>, createdAt?: string): KnowledgeEdge {
    const id = `edge_${randomUUID().slice(0, 8)}`;
    const edge: KnowledgeEdge = {
      id,
      source,
      target,
      relation,
      metadata,
      createdAt: createdAt ?? new Date().toISOString(),
    };
    this.edges.set(id, edge);
    return edge;
  }

  public addNode(node: Omit<KnowledgeNode, 'id' | 'createdAt'> & { id?: string }): KnowledgeNode {
    const id = node.id || `node_${node.type}_${randomUUID().slice(0, 8)}`;
    const fullNode: KnowledgeNode = {
      ...node,
      id,
      createdAt: new Date().toISOString(),
    };
    this.nodes.set(id, fullNode);
    eventBus.emitEvent('graph:node_added', 'knowledge_graph', { nodeId: id, type: fullNode.type, label: fullNode.label });
    return fullNode;
  }

  public getNode(id: string): KnowledgeNode | undefined {
    return this.nodes.get(id);
  }

  public listNodes(filter?: { type?: KnowledgeNodeType; projectId?: string; search?: string; limit?: number }): KnowledgeNode[] {
    let list = Array.from(this.nodes.values());
    if (filter?.type) {
      list = list.filter((n) => n.type === filter.type);
    }
    if (filter?.projectId) {
      list = list.filter((n) => n.projectId === filter.projectId);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      list = list.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    }
    const limit = filter?.limit ?? 200;
    return list.slice(0, limit);
  }

  public addEdge(source: string, target: string, relation: KnowledgeEdgeRelation, metadata?: Record<string, unknown>): KnowledgeEdge {
    const edge = this.addEdgeInternal(source, target, relation, metadata);
    eventBus.emitEvent('graph:edge_added', 'knowledge_graph', { edgeId: edge.id, source, target, relation });
    return edge;
  }

  public getEdges(nodeId?: string): KnowledgeEdge[] {
    const all = Array.from(this.edges.values());
    if (!nodeId) return all;
    return all.filter((e) => e.source === nodeId || e.target === nodeId);
  }

  public getNeighbors(nodeId: string, relation?: KnowledgeEdgeRelation): { node: KnowledgeNode; edge: KnowledgeEdge; direction: 'outgoing' | 'incoming' }[] {
    const results: { node: KnowledgeNode; edge: KnowledgeEdge; direction: 'outgoing' | 'incoming' }[] = [];
    for (const edge of this.edges.values()) {
      if (relation && edge.relation !== relation) continue;
      if (edge.source === nodeId) {
        const neighbor = this.nodes.get(edge.target);
        if (neighbor) results.push({ node: neighbor, edge, direction: 'outgoing' });
      } else if (edge.target === nodeId) {
        const neighbor = this.nodes.get(edge.source);
        if (neighbor) results.push({ node: neighbor, edge, direction: 'incoming' });
      }
    }
    return results;
  }

  public getSubgraph(rootId: string, maxDepth: number = 2): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    const visitedNodes = new Set<string>();
    const collectedEdges = new Set<KnowledgeEdge>();
    const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visitedNodes.has(id)) continue;
      visitedNodes.add(id);

      if (depth < maxDepth) {
        const neighbors = this.getNeighbors(id);
        for (const n of neighbors) {
          collectedEdges.add(n.edge);
          if (!visitedNodes.has(n.node.id)) {
            queue.push({ id: n.node.id, depth: depth + 1 });
          }
        }
      }
    }

    const nodes = Array.from(visitedNodes).map((id) => this.nodes.get(id)).filter(Boolean) as KnowledgeNode[];
    return {
      nodes,
      edges: Array.from(collectedEdges),
    };
  }

  public getStats(): { totalNodes: number; totalEdges: number; byType: Record<string, number>; byRelation: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      byType[node.type] = (byType[node.type] || 0) + 1;
    }
    const byRelation: Record<string, number> = {};
    for (const edge of this.edges.values()) {
      byRelation[edge.relation] = (byRelation[edge.relation] || 0) + 1;
    }
    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      byType,
      byRelation,
    };
  }
}

export const knowledgeGraphService = KnowledgeGraphService.getInstance();
