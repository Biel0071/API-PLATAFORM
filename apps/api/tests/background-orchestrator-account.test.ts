import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ completeMission: vi.fn(), cancelMission: vi.fn(), route: vi.fn() }));
vi.mock('../src/services/event-bus.service', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('../src/services/missions.service', () => ({ missionsService: {
  addStep: vi.fn(() => ({ id: 'step-1' })), updateStep: vi.fn(), completeMission: state.completeMission, cancelMission: state.cancelMission,
} }));
vi.mock('../src/services/queue.service', () => ({ enqueueWithTiming: vi.fn() }));
vi.mock('../src/services/smart-router.service', () => ({ smartRouterService: {
  route: state.route, executeWithSmartFallback: vi.fn(),
} }));
vi.mock('../src/services/operational-memory.service', () => ({ operationalMemoryService: { recordDecision: vi.fn() } }));
vi.mock('../src/lib/redis', () => ({ redis: { status: 'wait' } }));
vi.mock('../src/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { BackgroundOrchestratorService } from '../src/services/background-orchestrator.service';
import { eventBus } from '../src/services/event-bus.service';

describe('background pipeline with pinned provider account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a pinned provider failure without completing or rejecting detached work', async () => {
    state.route.mockRejectedValueOnce(Object.assign(new Error('token=must-not-leak'), { statusCode: 503, code: 'UPSTREAM_ERROR' }));

    await expect(BackgroundOrchestratorService.runPipelineDetached('mission-1', 'prompt', undefined, undefined, 'account-a'))
      .resolves.toBeUndefined();

    expect(state.completeMission).not.toHaveBeenCalled();
    expect(state.cancelMission).toHaveBeenCalledWith('mission-1');
    expect(eventBus.emitEvent).toHaveBeenCalledWith(
      'mission:failed',
      'background-orchestrator',
      { missionId: 'mission-1', error: 'Provider request failed (503): UPSTREAM_ERROR' },
      expect.anything(),
    );
  });
});
