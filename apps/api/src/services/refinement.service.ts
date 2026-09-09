import { JudgeService } from './judge.service';

export type RefinementOptions = { maxRefinements?: number; qualityThreshold?: number; budgetTokens?: number };
export type RefinementResult = { response: unknown; refinements: number; qualityScore: number; stoppedReason: string };

/** Bounded refinement coordinator. The executor is injected so this stays provider agnostic. */
export async function refineResponse(originalTask: string, optimizedPrompt: string, initial: unknown, execute: (prompt: string) => Promise<unknown>, options: RefinementOptions = {}): Promise<RefinementResult> {
  const limit = Math.max(0, Math.min(10, Number(options.maxRefinements ?? process.env.MAX_REFINEMENTS ?? 2)));
  const threshold = Number(options.qualityThreshold ?? process.env.QUALITY_THRESHOLD ?? 80);
  let response = initial;
  let refinements = 0;
  let consumedTokens = 0;
  let qualityScore = JudgeService.evaluate(originalTask, optimizedPrompt, [{ response }]).qualityScore;
  while (qualityScore < threshold && refinements < limit) {
    if (options.budgetTokens !== undefined && options.budgetTokens <= 0) return { response, refinements, qualityScore, stoppedReason: 'budget_exhausted' };
    const responseTokens = Math.max(1, Math.ceil(JSON.stringify(response ?? '').length / 4));
    if (options.budgetTokens !== undefined && consumedTokens + responseTokens >= options.budgetTokens) {
      return { response, refinements, qualityScore, stoppedReason: 'budget_exhausted' };
    }
    response = await execute(`${optimizedPrompt}\n\nREFINE the previous answer for correctness and completeness:\n${typeof response === 'string' ? response : JSON.stringify(response)}`);
    refinements += 1;
    consumedTokens += responseTokens;
    qualityScore = JudgeService.evaluate(originalTask, optimizedPrompt, [{ response }]).qualityScore;
  }
  return { response, refinements, qualityScore, stoppedReason: qualityScore >= threshold ? 'quality_threshold' : 'max_refinements' };
}
