import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { visualIDEService } from '../../services/visual-ide.service';

const listFilesSchema = z.object({
  baseDir: z.string().min(1),
  maxDepth: z.number().int().min(0).max(5).default(2),
});

const readFileSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const patchFileSchema = z.object({
  filePath: z.string().min(1),
  targetContent: z.string().min(1),
  replacementContent: z.string(),
});

const saveFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
});

export async function visualIDERoutes(app: FastifyInstance): Promise<void> {
  app.post('/ide/files', { schema: { tags: ['v1', 'ide'] } }, async (req, reply) => {
    const body = listFilesSchema.parse(req.body);
    try {
      const files = await visualIDEService.listFiles(body.baseDir, body.maxDepth);
      return { success: true, count: files.length, files };
    } catch (err) {
      return reply.code(400).send({ success: false, error: { code: 'EXPLORE_FAILED', message: String(err) } });
    }
  });

  app.post('/ide/file', { schema: { tags: ['v1', 'ide'] } }, async (req, reply) => {
    const body = readFileSchema.parse(req.body);
    try {
      const result = await visualIDEService.readFileContent(body.filePath, body.startLine, body.endLine);
      return { success: true, ...result };
    } catch (err) {
      return reply.code(404).send({ success: false, error: { code: 'FILE_READ_FAILED', message: String(err) } });
    }
  });

  app.post('/ide/patch', { schema: { tags: ['v1', 'ide'] } }, async (req, reply) => {
    const body = patchFileSchema.parse(req.body);
    try {
      const result = await visualIDEService.applyPatch(body.filePath, body.targetContent, body.replacementContent);
      return result;
    } catch (err) {
      return reply.code(400).send({ success: false, error: { code: 'PATCH_FAILED', message: String(err) } });
    }
  });

  app.post('/ide/save', { schema: { tags: ['v1', 'ide'] } }, async (req, reply) => {
    const body = saveFileSchema.parse(req.body);
    try {
      const result = await visualIDEService.writeFileContent(body.filePath, body.content);
      return result;
    } catch (err) {
      return reply.code(400).send({ success: false, error: { code: 'SAVE_FAILED', message: String(err) } });
    }
  });
}
