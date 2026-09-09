import type { FastifyInstance } from 'fastify';
import { centralMonitoringService } from '../../services/central-monitoring.service';

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.get('/monitoring/dashboard', { schema: { tags: ['v1', 'monitoring'] } }, async () => {
    const data = await centralMonitoringService.getDashboardData();
    return { success: true, data };
  });

  app.get('/monitoring/workers', { schema: { tags: ['v1', 'monitoring'] } }, async () => {
    const data = await centralMonitoringService.getDashboardData();
    return { success: true, workers: data.workers };
  });

  app.get('/monitoring/jobs', { schema: { tags: ['v1', 'monitoring'] } }, async () => {
    const data = await centralMonitoringService.getDashboardData();
    return { success: true, queues: data.queues };
  });

  app.get('/monitoring/ai-usage', { schema: { tags: ['v1', 'monitoring'] } }, async () => {
    const data = await centralMonitoringService.getDashboardData();
    return { success: true, aiUsage: data.aiUsage };
  });

  app.get('/monitoring/telemetry', { schema: { tags: ['v1', 'monitoring'] } }, async () => {
    const data = await centralMonitoringService.getDashboardData();
    return { success: true, system: data.system, recentEvents: data.recentEvents };
  });
}
