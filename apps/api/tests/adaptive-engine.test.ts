import { describe, expect, it } from 'vitest';
import { PromptOptimizer } from '../src/services/prompt-optimizer.service';
import { TaskClassifier } from '../src/services/task-classifier.service';
import { JudgeService } from '../src/services/judge.service';
import { refineResponse } from '../src/services/refinement.service';
import { executeParallel } from '../src/services/parallel-execution.service';

describe('adaptive engine primitives', () => {
  it('structures a prompt without losing the original objective', () => {
    const result = PromptOptimizer.optimize({ originalPrompt: 'implementar login', constraints: ['preservar API'] });
    expect(result.optimizedPrompt).toContain('implementar login');
    expect(result.optimizedPrompt).toContain('preservar API');
    expect(result.promptVersion).toBe('prompt-v1');
  });

  it('classifies coding work and estimates non-zero tokens', () => {
    const result = TaskClassifier.classify([{ role: 'user', content: 'corrija este código TypeScript' }]);
    expect(result.taskType).toBe('coding');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('selects the strongest candidate', () => {
    const result = JudgeService.evaluate('responda', 'OBJECTIVE: responda', [{ response: '' }, { response: 'resposta correta', latencyMs: 10 }]);
    expect(result.winner).toBe(1);
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  it('stops refinement at the configured limit', async () => {
    const result = await refineResponse('x', 'OBJECTIVE: x', '', async () => 'ok', { maxRefinements: 2, qualityThreshold: 100 });
    expect(result.refinements).toBe(2);
    expect(result.stoppedReason).toBe('max_refinements');
  });

  it('isolates failed parallel candidates', async () => {
    const result = await executeParallel([async () => 'a', async () => { throw new Error('failed'); }, async () => 'c'], 2);
    expect(result.fulfilled).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.results[1]).toMatchObject({ status: 'rejected' });
  });
});
