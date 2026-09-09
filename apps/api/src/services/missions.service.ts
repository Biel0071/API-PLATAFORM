import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { agentsService } from './agents.service';
import { logger } from '../lib/logger';

export interface MissionStep {
  id: string;
  stepNumber: number;
  title: string;
  tool?: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  context?: string;
  status: 'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  priority: number;
  steps: MissionStep[];
  targetRepository?: string;
  result?: Record<string, unknown>;
  error?: string;
  tokens: { prompt: number; completion: number; total: number };
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export class MissionsService {
  private static instance: MissionsService;
  private missions: Map<string, Mission> = new Map();

  private constructor() {}

  public static getInstance(): MissionsService {
    if (!MissionsService.instance) {
      MissionsService.instance = new MissionsService();
    }
    return MissionsService.instance;
  }

  public listMissions(filter?: { status?: string; agentId?: string }): Mission[] {
    let list = Array.from(this.missions.values());
    if (filter?.status) {
      list = list.filter((m) => m.status === filter.status);
    }
    if (filter?.agentId) {
      list = list.filter((m) => m.agentId === filter.agentId);
    }
    return list.reverse();
  }

  public getMission(id: string): Mission | undefined {
    return this.missions.get(id);
  }

  public createMission(data: {
    id?: string;
    title: string;
    objective: string;
    context?: string;
    agentId?: string;
    priority?: number;
    targetRepository?: string;
    autoStart?: boolean;
  }): Mission {
    const id = data.id || `mission_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const agentId = data.agentId || 'executive-brain';

    const mission: Mission = {
      id,
      title: data.title,
      objective: data.objective,
      context: data.context,
      status: data.autoStart ? 'in_progress' : 'pending',
      agentId,
      priority: data.priority ?? 5,
      steps: [],
      targetRepository: data.targetRepository,
      tokens: { prompt: 0, completion: 0, total: 0 },
      createdAt: now,
      startedAt: data.autoStart ? now : undefined,
    };

    this.missions.set(id, mission);
    eventBus.emitEvent('mission:created', 'missions_service', { missionId: id, title: mission.title, agentId });

    if (data.autoStart) {
      agentsService.updateStatus(agentId, 'working');
    }

    return mission;
  }

  public addStep(missionId: string, title: string, tool?: string): MissionStep | undefined {
    const mission = this.missions.get(missionId);
    if (!mission) return undefined;

    const step: MissionStep = {
      id: `step_${randomUUID().slice(0, 6)}`,
      stepNumber: mission.steps.length + 1,
      title,
      tool,
      status: 'pending',
    };

    mission.steps.push(step);
    eventBus.emitEvent('mission:step_added', 'missions_service', { missionId, stepId: step.id, title });
    return step;
  }

  public updateStep(
    missionId: string,
    stepId: string,
    update: { status: MissionStep['status']; result?: unknown; error?: string; durationMs?: number },
  ): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;
    const step = mission.steps.find((s) => s.id === stepId);
    if (!step) return false;

    step.status = update.status;
    if (update.result !== undefined) step.result = update.result;
    if (update.error !== undefined) step.error = update.error;
    if (update.durationMs !== undefined) step.durationMs = update.durationMs;

    eventBus.emitEvent('mission:step_updated', 'missions_service', { missionId, stepId, status: update.status });
    return true;
  }

  public completeMission(missionId: string, result: Record<string, unknown>, tokens?: { prompt: number; completion: number }): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;

    const now = new Date().toISOString();
    mission.status = 'completed';
    mission.result = result;
    mission.finishedAt = now;
    if (mission.startedAt) {
      mission.durationMs = new Date(now).getTime() - new Date(mission.startedAt).getTime();
    }
    if (tokens) {
      mission.tokens.prompt += tokens.prompt;
      mission.tokens.completion += tokens.completion;
      mission.tokens.total = mission.tokens.prompt + mission.tokens.completion;
    }

    agentsService.recordTaskResult(mission.agentId, true);
    eventBus.emitEvent('mission:completed', 'missions_service', { missionId, durationMs: mission.durationMs, result });
    return true;
  }

  public failMission(missionId: string, error: string): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;

    const now = new Date().toISOString();
    mission.status = 'failed';
    mission.error = error;
    mission.finishedAt = now;
    if (mission.startedAt) {
      mission.durationMs = new Date(now).getTime() - new Date(mission.startedAt).getTime();
    }

    agentsService.recordTaskResult(mission.agentId, false);
    eventBus.emitEvent('mission:failed', 'missions_service', { missionId, error }, { severity: 'error' });
    return true;
  }

  public cancelMission(missionId: string): boolean {
    const mission = this.missions.get(missionId);
    if (!mission) return false;

    mission.status = 'cancelled';
    mission.finishedAt = new Date().toISOString();
    agentsService.updateStatus(mission.agentId, 'idle');
    eventBus.emitEvent('mission:cancelled', 'missions_service', { missionId }, { severity: 'warn' });
    return true;
  }
}

export const missionsService = MissionsService.getInstance();
