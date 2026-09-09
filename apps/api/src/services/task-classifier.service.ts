import { estimatePayloadTokens } from '@api-platform/shared';

export type TaskType = 'simple' | 'coding' | 'reasoning' | 'planning' | 'research' | 'summarization' | 'vision' | 'data_analysis' | 'creative' | 'complex_agentic';
export type TaskClassification = { taskType: TaskType; complexityScore: number; confidenceScore: number; estimatedTokens: number; estimatedAgents: number; estimatedCost: number };

export class TaskClassifier {
  static classify(messages: any[], options: { tools?: any[] } = {}): TaskClassification {
    const text = messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')).join('\n');
    const lower = text.toLowerCase();
    const estimatedTokens = estimatePayloadTokens(messages as any);
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    const hasVision = messages.some((message) => Array.isArray(message.content) && message.content.some((part: any) => ['image', 'image_url'].includes(part.type)));
    let taskType: TaskType = 'simple';
    if (hasVision) taskType = 'vision';
    else if (/\b(código|codigo|program|implementar|bug|refator|typescript|javascript|python)\b/.test(lower)) taskType = 'coding';
    else if (/\b(analis|calcule|dados|csv|métrica|estatística)\b/.test(lower)) taskType = 'data_analysis';
    else if (/\b(plano|planej|roadmap|etapas)\b/.test(lower)) taskType = 'planning';
    else if (/\b(pesquis|fontes|compare|investigue)\b/.test(lower)) taskType = 'research';
    else if (/\b(resum|síntese|sintese)\b/.test(lower)) taskType = 'summarization';
    else if (/\b(crie|escreva|roteiro|ideia|design)\b/.test(lower)) taskType = 'creative';
    else if (hasTools || estimatedTokens > 1200) taskType = 'complex_agentic';
    const complexityScore = Math.min(100, Math.round((estimatedTokens / 2000) * 70) + (hasTools ? 20 : 0) + (taskType === 'simple' ? 0 : 10));
    const estimatedAgents = complexityScore > 80 ? 3 : complexityScore > 60 ? 2 : 1;
    return { taskType, complexityScore, confidenceScore: Math.min(99, 70 + (text ? 20 : 0)), estimatedTokens, estimatedAgents, estimatedCost: estimatedTokens * 0.0000015 };
  }
}
