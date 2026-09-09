import { estimatePayloadTokens } from '@api-platform/shared';

export type PromptOptimizationInput = {
  originalPrompt: string;
  context?: string;
  taskType?: string;
  constraints?: string[];
};

export type PromptOptimizationResult = PromptOptimizationInput & {
  optimizedPrompt: string;
  promptVersion: string;
  optimizerVersion: string;
  estimatedTokens: number;
};

/** Deterministic optimizer: structures the request while preserving its wording and intent. */
export class PromptOptimizer {
  static readonly version = '1.0.0';

  static optimize(input: PromptOptimizationInput): PromptOptimizationResult {
    const originalPrompt = String(input.originalPrompt || '').trim();
    const context = input.context?.trim();
    const taskType = input.taskType?.trim() || 'general';
    const constraints = (input.constraints || []).map(String).map((item) => item.trim()).filter(Boolean);
    const sections = [`OBJECTIVE:\n${originalPrompt}`, `TASK TYPE:\n${taskType}`];
    if (context) sections.push(`CONTEXT:\n${context}`);
    if (constraints.length) sections.push(`CONSTRAINTS:\n${constraints.map((item) => `- ${item}`).join('\n')}`);
    sections.push('SUCCESS CRITERIA:\n- Answer the original request accurately.\n- Preserve the stated constraints.');
    const optimizedPrompt = sections.join('\n\n');
    return { ...input, originalPrompt, context, taskType, constraints, optimizedPrompt,
      promptVersion: 'prompt-v1', optimizerVersion: PromptOptimizer.version,
      estimatedTokens: estimatePayloadTokens([{ role: 'user', content: optimizedPrompt }]) };
  }
}
