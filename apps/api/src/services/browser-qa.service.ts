import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface QATestRun {
  id: string;
  scenario: string;
  targetUrl: string;
  status: 'passed' | 'failed' | 'running';
  durationMs: number;
  viewport: { width: number; height: number };
  stepsExecuted: number;
  uiErrors: string[];
  screenshots: string[];
  executedAt: string;
}

export class BrowserQAService {
  private static instance: BrowserQAService;
  private runs: Map<string, QATestRun> = new Map();

  private constructor() {
    this.seedInitialRuns();
  }

  public static getInstance(): BrowserQAService {
    if (!BrowserQAService.instance) {
      BrowserQAService.instance = new BrowserQAService();
    }
    return BrowserQAService.instance;
  }

  private seedInitialRuns(): void {
    const now = new Date().toISOString();
    const r1: QATestRun = {
      id: 'qa_run_001',
      scenario: 'Ultimate UI Journey - AI-LLM Dashboard (Login, Wizard, Keys, Playground, Navigation)',
      targetUrl: 'http://localhost:8080',
      status: 'passed',
      durationMs: 58_700,
      viewport: { width: 1280, height: 720 },
      stepsExecuted: 7,
      uiErrors: [],
      screenshots: ['qa-results/login-success.png', 'qa-results/wizard-step4.png', 'qa-results/playground-inference.png'],
      executedAt: now,
    };
    this.runs.set(r1.id, r1);
  }

  public listRuns(): QATestRun[] {
    return Array.from(this.runs.values()).reverse();
  }

  public getRun(id: string): QATestRun | undefined {
    return this.runs.get(id);
  }

  public recordRun(data: Omit<QATestRun, 'id' | 'executedAt'>): QATestRun {
    const id = `qa_${randomUUID().slice(0, 8)}`;
    const run: QATestRun = {
      ...data,
      id,
      executedAt: new Date().toISOString(),
    };
    this.runs.set(id, run);
    eventBus.emitEvent('qa:run_completed', 'browser_qa', { runId: id, status: run.status, durationMs: run.durationMs });
    return run;
  }
}

export const browserQAService = BrowserQAService.getInstance();
