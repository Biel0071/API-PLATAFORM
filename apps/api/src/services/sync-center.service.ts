import os from 'node:os';

export interface ClusterNode {
  nodeId: string;
  host: string;
  port: number;
  role: 'leader' | 'worker';
  status: 'ONLINE' | 'OFFLINE' | 'SYNCING';
  cpuUsagePercent: number | null;
  ramUsagePercent: number | null;
  activeJobsCount: number | null;
  lastHeartbeat: string;
}

export class SyncCenterService {
  private nodes: Map<string, ClusterNode> = new Map();

  constructor() {
    this.registerLocalNode();
  }

  private registerLocalNode() {
    const localNode: ClusterNode = {
      nodeId: os.hostname(),
      host: os.hostname(),
      port: Number(process.env.PORT || 3000),
      role: 'leader',
      status: 'ONLINE',
      cpuUsagePercent: null,
      ramUsagePercent: 100 * (1 - os.freemem() / os.totalmem()),
      activeJobsCount: null,
      lastHeartbeat: new Date().toISOString(),
    };
    this.nodes.set(localNode.nodeId, localNode);
  }

  public getClusterStatus() {
    const local = this.nodes.get(os.hostname());
    if (local) {
      local.lastHeartbeat = new Date().toISOString();
      local.ramUsagePercent = Math.round(10000 * (1 - os.freemem() / os.totalmem())) / 100;
    }
    for (const node of this.nodes.values()) {
      node.status = Date.now() - Date.parse(node.lastHeartbeat) < 60000 ? 'ONLINE' : 'OFFLINE';
    }
    return {
      storage: 'process-memory',
      mode: 'standalone',
      clusterId: 'api-platform-cluster-global',
      totalNodes: this.nodes.size,
      activeNodes: Array.from(this.nodes.values()).filter((n) => n.status === 'ONLINE').length,
      nodes: Array.from(this.nodes.values()),
    };
  }

  public registerNode(nodeData: Partial<ClusterNode>): ClusterNode {
    const nodeId = nodeData.nodeId || `vps-node-${Date.now()}`;
    const node: ClusterNode = {
      nodeId,
      host: nodeData.host || '0.0.0.0',
      port: nodeData.port || 3000,
      role: nodeData.role || 'worker',
      status: 'ONLINE',
      cpuUsagePercent: nodeData.cpuUsagePercent ?? null,
      ramUsagePercent: nodeData.ramUsagePercent ?? null,
      activeJobsCount: nodeData.activeJobsCount ?? null,
      lastHeartbeat: new Date().toISOString(),
    };
    this.nodes.set(nodeId, node);
    return node;
  }

  public heartbeat(nodeId: string, metrics?: Partial<ClusterNode>): ClusterNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Nó de cluster não encontrado: ${nodeId}`);

    node.lastHeartbeat = new Date().toISOString();
    node.status = 'ONLINE';
    if (metrics) {
      if (metrics.cpuUsagePercent !== undefined) node.cpuUsagePercent = metrics.cpuUsagePercent;
      if (metrics.ramUsagePercent !== undefined) node.ramUsagePercent = metrics.ramUsagePercent;
      if (metrics.activeJobsCount !== undefined) node.activeJobsCount = metrics.activeJobsCount;
    }
    return node;
  }
}
