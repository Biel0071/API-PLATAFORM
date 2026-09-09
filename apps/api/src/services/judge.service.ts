export type JudgeCandidate = { response: unknown; provider?: string; model?: string; latencyMs?: number; tokens?: number };
export type JudgeResult = { qualityScore: number; confidence: number; winner: number; reason: string; finalResponse: unknown };

/** Cheap, deterministic judge used when a caller supplies multiple candidates. */
export class JudgeService {
  static evaluate(originalTask: string, optimizedPrompt: string, candidates: JudgeCandidate[]): JudgeResult {
    if (!candidates.length) return { qualityScore: 0, confidence: 0, winner: -1, reason: 'no candidates', finalResponse: null };
    const score = (candidate: JudgeCandidate) => {
      const text = typeof candidate.response === 'string' ? candidate.response : JSON.stringify(candidate.response ?? '');
      const useful = text.trim().length > 0 ? 55 : 0;
      const relevant = originalTask && text.toLowerCase().split(/\s+/).some((word) => optimizedPrompt.toLowerCase().includes(word)) ? 25 : 0;
      const concise = text.length < 20_000 ? 10 : 0;
      const reliable = candidate.latencyMs !== undefined && candidate.latencyMs < 30_000 ? 10 : 0;
      return useful + relevant + concise + reliable;
    };
    const ranked = candidates.map((candidate, index) => ({ index, score: score(candidate) })).sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    return { qualityScore: winner.score, confidence: ranked.length > 1 ? Math.min(99, 60 + Math.max(0, winner.score - ranked[1].score)) : 70, winner: winner.index, reason: `candidate ${winner.index} scored highest on usefulness, relevance and reliability`, finalResponse: candidates[winner.index].response };
  }
}
