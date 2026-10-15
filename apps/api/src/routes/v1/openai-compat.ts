import { FastifyInstance } from 'fastify';
import { ExecutionGateway } from '../../services/execution-gateway.service';
import { ProviderStream } from '@api-platform/shared';
import { serializeProviderFailure } from '../../lib/provider-error-serialization';

export async function registerOpenAICompatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.requireApiKey);

  fastify.post('/v1/chat/completions', async (request: any, reply) => {
    console.log('[ENTRY] Recebida requisicao POST /v1/chat/completions');
    const { messages, model, temperature, max_tokens, stream, tools, tool_choice, response_format } = request.body || {};
    const capability = request.headers['x-capability'] || (request.query as any)?.capability || request.body?.capability;
    const pool = request.headers['x-pool'] || (request.query as any)?.pool || request.body?.pool;
    const routingPolicy = request.headers['x-routing-policy'] || request.body?.routingPolicy || request.body?.routing_policy;
    const dualLane = request.body?.dualLane ?? request.body?.dual_lane;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({
        error: { message: 'Campo "messages" é obrigatório e deve ser uma lista não vazia.', type: 'invalid_request_error', param: 'messages', code: 400 },
      });
    }

    const tenantId = request.auth?.tenantId || 'default_tenant';

    try {
      const { ctx, response } = await ExecutionGateway.execute(tenantId, {
        messages: messages,
        model: model || pool || capability || 'auto',
        capability,
        provider: request.body?.provider,
        providerAccountId: request.body?.providerAccountId,
        routingPolicy,
        pool,
        temperature,
        maxTokens: max_tokens,
        tools,
        toolChoice: tool_choice,
        format: response_format?.type === 'json_object' ? 'json' : undefined,
        stream,
        dualLane,
      }, stream, { scopes: request.auth?.scopes });

      const completionId = `chatcmpl-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);

      // Metadados do gateway de observabilidade
      const gatewayTrace = {
        requestId: request.id || crypto.randomUUID(),
        executionId: ctx.executionId,
        mode: ctx.decision?.mode,
        transport: ctx.decision?.transport,
        provider: (ctx.metrics as any)?.provider || (response as any).provider || 'auto',
        cache: ctx.cacheHit,
        planner: ctx.plannerUsed,
        queue: ctx.queueUsed,
        cost: ctx.complexity?.estimatedCost || 0,
        metrics: ctx.metrics,
        trace: ctx.trace,
        system1Decision: ctx.metadata?.system1Decision,
      };

      if ('stream' in response && response.stream) {
        console.log('[STREAM] Iniciando streaming de resposta ao cliente');
        // Handle SSE Streaming (Eventos Estruturados)
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        // 1. Opcional: Alguns clientes quebram se receberem custom events, então removemos o `event: ...` dos principais
        reply.raw.write(`data: ${JSON.stringify({ _gateway: gatewayTrace })}\n\n`);

        const heartbeat = setInterval(() => {
          reply.raw.write(':ping\n\n');
        }, 15000);

        try {
          const streamResponse = response as ProviderStream;
          let roleSent = false;

          // Se for cascata com System 1 fastResponse, emite chunk inicial da decisão semântica
          if ((dualLane || request.body?.cascade) && ctx.metadata?.system1Decision?.fastResponse) {
            const rolePayload = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: timestamp,
              model: streamResponse.model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
            };
            reply.raw.write(`data: ${JSON.stringify(rolePayload)}\n\n`);
            roleSent = true;

            const fastChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: timestamp,
              model: streamResponse.model,
              choices: [{ 
                index: 0, 
                delta: { content: `/* ${ctx.metadata.system1Decision.fastResponse} */\n\n` }, 
                finish_reason: null 
              }]
            };
            reply.raw.write(`data: ${JSON.stringify(fastChunk)}\n\n`);
          }
          
          for await (const chunk of streamResponse.chunks) {
            if (chunk.type === 'status') {
              // Ignore ou mande como custom se suportado
              continue;
            }

            if (!roleSent) {
              const rolePayload = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model: streamResponse.model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
              };
              reply.raw.write(`data: ${JSON.stringify(rolePayload)}\n\n`);
              roleSent = true;
            }

            if (chunk.type === 'delta') {
              const chunkPayload = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model: streamResponse.model,
                choices: [{ 
                  index: 0, 
                  delta: { content: chunk.text }, 
                  finish_reason: chunk.finishReason || null 
                }]
              };
              reply.raw.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
            } else if (chunk.type === 'tool_calls') {
              const chunkPayload = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model: streamResponse.model,
                choices: [{ 
                  index: 0, 
                  delta: { 
                    tool_calls: chunk.toolCalls.map((tc: any) => ({
                      index: tc.index,
                      id: tc.id,
                      type: tc.id ? 'function' : undefined,
                      function: { name: tc.name, arguments: tc.arguments }
                    }))
                  },
                  finish_reason: null
                }]
              };
              reply.raw.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
            } else if (chunk.type === 'usage') {
              // OpenAI padrao manda uso num chunk final ou em options=stream_options
              reply.raw.write(`data: ${JSON.stringify({ 
                usage: {
                  prompt_tokens: chunk.promptTokens,
                  completion_tokens: chunk.completionTokens,
                  total_tokens: chunk.totalTokens
                }
              })}\n\n`);
            }
          }
          
          reply.raw.write('data: [DONE]\n\n');
        } finally {
          clearInterval(heartbeat);
          reply.raw.end();
        }
        
        return;
      } else {
        // Handle Synchronous Response
        const syncResponse = response as any;
        const content = syncResponse.result?.message?.content || syncResponse.result?.text || '';
        const resolvedModel = syncResponse.model || model || 'auto';
        
        return reply.send({
          id: completionId,
          object: 'chat.completion',
          created: timestamp,
          model: resolvedModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
              },
              finish_reason: 'stop',
            },
          ],
          usage: syncResponse.tokens || {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
          _gateway: gatewayTrace
        });
      }
    } catch (err: any) {
      const safeError = serializeProviderFailure(err);
      const { statusCode, errorCode } = safeError;
      fastify.log.warn({ statusCode, errorCode }, 'OpenAI compatibility request failed');
      return reply.status(statusCode).send({
        error: {
          message: safeError.message,
          type: 'api_error',
          code: statusCode,
        },
      });
    }
  });
}
