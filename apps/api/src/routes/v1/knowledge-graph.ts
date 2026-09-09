import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { knowledgeGraphService, KnowledgeNodeType, KnowledgeEdgeRelation } from '../../services/knowledge-graph.service';

const addNodeSchema = z.object({
  id: z.string().optional(),
  type: z.enum([
    'project',
    'file',
    'class',
    'function',
    'api',
    'agent',
    'skill',
    'event',
    'workflow',
    'database',
    'worker',
  ]),
  label: z.string().min(1).max(200),
  projectId: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const addEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum([
    'calls',
    'imports',
    'implements',
    'triggers',
    'depends_on',
    'reads_from',
    'writes_to',
    'assigned_to',
  ]),
  metadata: z.record(z.unknown()).optional(),
});

export async function knowledgeGraphRoutes(app: FastifyInstance): Promise<void> {
  app.get('/knowledge-graph/stats', { schema: { tags: ['v1', 'knowledge-graph'] } }, async () => {
    const stats = knowledgeGraphService.getStats();
    return { success: true, stats };
  });

  app.get('/knowledge-graph/nodes', { schema: { tags: ['v1', 'knowledge-graph'] } }, async (req) => {
    const query = req.query as { type?: KnowledgeNodeType; projectId?: string; search?: string; limit?: string };
    const nodes = knowledgeGraphService.listNodes({
      type: query.type,
      projectId: query.projectId,
      search: query.search,
      limit: query.limit ? Number(query.limit) : 200,
    });
    return { success: true, count: nodes.length, nodes };
  });

  app.get('/knowledge-graph/nodes/:id', { schema: { tags: ['v1', 'knowledge-graph'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = knowledgeGraphService.getNode(id);
    if (!node) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Nó não encontrado no grafo' } });
    }
    const neighbors = knowledgeGraphService.getNeighbors(id);
    return { success: true, node, neighbors };
  });

  app.post('/knowledge-graph/nodes', { schema: { tags: ['v1', 'knowledge-graph'] } }, async (req, reply) => {
    const body = addNodeSchema.parse(req.body);
    const node = knowledgeGraphService.addNode(body);
    return reply.code(201).send({ success: true, node });
  });

  app.post('/knowledge-graph/edges', { schema: { tags: ['v1', 'knowledge-graph'] } }, async (req, reply) => {
    const body = addEdgeSchema.parse(req.body);
    const edge = knowledgeGraphService.addEdge(body.source, body.target, body.relation, body.metadata);
    return reply.code(201).send({ success: true, edge });
  });

  app.get('/knowledge-graph/subgraph', { schema: { tags: ['v1', 'knowledge-graph'] } }, async (req, reply) => {
    const query = req.query as { rootId?: string; depth?: string };
    if (!query.rootId) {
      return reply.code(400).send({ success: false, error: { code: 'MISSING_ROOT_ID', message: 'rootId é obrigatório' } });
    }
    const subgraph = knowledgeGraphService.getSubgraph(query.rootId, query.depth ? Number(query.depth) : 2);
    return { success: true, subgraph };
  });
}
