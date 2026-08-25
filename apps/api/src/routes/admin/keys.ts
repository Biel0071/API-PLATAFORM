import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fail, hashApiKey } from '@api-platform/shared';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';

export async function keysRoutes(secured: FastifyInstance): Promise<void> {
  // API Keys
  secured.get('/api-keys', { schema: { tags: ['admin'] } }, async () => ({
    success: true,
    keys: await prisma.apiKey.findMany({
      select: {
        id: true, name: true, prefix: true, active: true, lastUsedAt: true, expiresAt: true,
        scopes: true, environment: true, createdAt: true,
        tenant: { select: { id: true, name: true, slug: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  }));

  secured.post('/api-keys', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1), tenantId: z.string().min(1), projectId: z.string().min(1).optional(),
      environment: z.enum(['live', 'test', 'dev']).default('live'),
      scopes: z.array(z.enum(['text', 'chat', 'image', 'video', 'vision', 'embed', 'ocr', 'workflow', 'admin'])).min(1).default(['text', 'chat']),
      expiresAt: z.string().datetime().optional(),
    }).parse(req.body);
    if (body.projectId) {
      const project = await prisma.project.findFirst({ where: { id: body.projectId, tenantId: body.tenantId } });
      if (!project) return reply.code(400).send(fail('INVALID_PROJECT', 'Projeto nao pertence ao tenant selecionado'));
    }
    const key = `ap_${body.environment}_${randomBytes(24).toString('hex')}`;
    const created = await prisma.apiKey.create({ data: {
      name: body.name, tenantId: body.tenantId, projectId: body.projectId,
      environment: body.environment, scopes: body.scopes.join(','),
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      keyHash: hashApiKey(key), prefix: key.slice(0, 14),
    } });
    return { success: true, id: created.id, key };
  });

  secured.delete('/api-keys/:id', { schema: { tags: ['admin'] } }, async (req) => {
    const { id } = req.params as { id: string };
    const revoked = await prisma.apiKey.update({ where: { id }, data: { active: false }, select: { keyHash: true } });
    await redis.del(`apiplatform:apikey:v2:${revoked.keyHash}`, `apiplatform:apikey:${revoked.keyHash}`);
    return { success: true };
  });

  secured.put('/api-keys/:id', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().min(1).optional(),
      environment: z.enum(['live', 'test', 'dev']).optional(),
      scopes: z.array(z.enum(['text', 'chat', 'image', 'video', 'vision', 'embed', 'ocr', 'workflow', 'admin'])).min(1).optional(),
    }).parse(req.body);
    
    const oldKey = await prisma.apiKey.findUnique({ where: { id } });
    if (!oldKey) return reply.code(404).send(fail('NOT_FOUND', 'Key not found'));
    
    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        name: body.name ?? oldKey.name,
        environment: body.environment ?? oldKey.environment,
        scopes: body.scopes ? body.scopes.join(',') : oldKey.scopes,
      }
    });

    // Invalida cache atual da key editada
    await redis.del(`apiplatform:apikey:v2:${updated.keyHash}`, `apiplatform:apikey:${updated.keyHash}`);
    
    return { success: true, key: updated };
  });

  secured.post('/api-keys/bulk-delete', { schema: { tags: ['admin'] } }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    
    const keys = await prisma.apiKey.findMany({ where: { id: { in: ids } }, select: { id: true, keyHash: true } });
    
    await prisma.apiKey.updateMany({
      where: { id: { in: keys.map((k: any) => k.id) } },
      data: { active: false }
    });
    
    const redisKeys = keys.flatMap((k: any) => [`apiplatform:apikey:v2:${k.keyHash}`, `apiplatform:apikey:${k.keyHash}`]);
    if (redisKeys.length > 0) {
      await redis.del(...redisKeys);
    }
    
    return { success: true, count: keys.length };
  });

  secured.post('/api-keys/:id/rotate', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const oldKey = await prisma.apiKey.findUnique({ where: { id } });
    if (!oldKey) return reply.code(404).send(fail('NOT_FOUND', 'Key not found'));
    
    // Revoke old key
    await prisma.apiKey.update({ where: { id }, data: { active: false } });
    await redis.del(`apiplatform:apikey:v2:${oldKey.keyHash}`, `apiplatform:apikey:${oldKey.keyHash}`);

    // Create new key with same properties
    const key = `ap_${oldKey.environment}_${randomBytes(24).toString('hex')}`;
    const newApiKey = await prisma.apiKey.create({
      data: {
        name: oldKey.name + ' (Rotated)',
        tenantId: oldKey.tenantId,
        projectId: oldKey.projectId,
        environment: oldKey.environment,
        scopes: oldKey.scopes,
        expiresAt: oldKey.expiresAt,
        keyHash: hashApiKey(key),
        prefix: key.slice(0, 14),
      }
    });

    return { success: true, id: newApiKey.id, key };
  });
}

