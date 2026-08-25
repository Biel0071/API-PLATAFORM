import { FastifyInstance } from 'fastify';
import { ExecutionGateway } from '../../services/execution-gateway.service';
import { ProviderStream } from '@api-platform/shared';
import { anthropicContentToText, normalizeAnthropicMessages, normalizeAnthropicToolChoice, normalizeAnthropicTools } from './anthropic-compat.mapper';

function createMessageId(): string {
  return `msg_${Date.now()}`;
}

function setAnthropicSseHeaders(reply: any): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders();
}

function writeAnthropicEvent(reply: any, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function anthropicUsage(tokens: any): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: Number(tokens?.prompt ?? tokens?.input_tokens ?? 0),
    output_tokens: Number(tokens?.completion ?? tokens?.output_tokens ?? 0),
  };
}

function normalizeAnthropicModel(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined;
  return model.toLowerCase().startsWith('claude-') ? 'auto' : model;
}

function compactAnthropicSystem(system: string): string {
  const limit = Number(process.env.ANTHROPIC_COMPAT_SYSTEM_MAX_CHARS ?? 2000);
  if (!system) return system;
  if (Number.isFinite(limit) && limit === 0) return '';
  if (!Number.isFinite(limit) || limit < 0 || system.length <= limit) {
    return system;
  }

  const headLength = Math.floor(limit * 0.7);
  const tailLength = Math.max(0, limit - headLength);
  return [
    system.slice(0, headLength),
    '[system compacted by Anthropic adapter for local gateway latency]',
    system.slice(-tailLength),
  ].join('\n\n');
}

function clampAnthropicMaxTokens(maxTokens: unknown): number | undefined {
  const requested = typeof maxTokens === 'number' ? maxTokens : Number(maxTokens);
  if (!Number.isFinite(requested) || requested <= 0) return undefined;

  const cap = Number(process.env.ANTHROPIC_COMPAT_MAX_TOKENS_CAP ?? 512);
  if (!Number.isFinite(cap) || cap <= 0) return Math.floor(requested);

  return Math.min(Math.floor(requested), Math.floor(cap));
}

function shouldForwardTools(model: string | undefined, toolChoice: unknown): boolean {
  if (model && model !== 'auto') return true;
  if (!toolChoice || typeof toolChoice !== 'object') return false;
  const choice = toolChoice as Record<string, any>;
  return choice.type === 'tool';
}

export async function registerAnthropicCompatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.requireApiKey);

  fastify.post('/v1/messages', async (request: any, reply) => {
    console.log('[ENTRY] Recebida requisicao POST /v1/messages (Anthropic Compat)');
    const { messages, system, model, temperature, max_tokens, stream, tools, tool_choice } = request.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages is required' },
      });
    }

    const tenantId = request.auth?.tenantId || 'default_tenant';

    const normalizedSystem = compactAnthropicSystem(anthropicContentToText(system));
    const internalMessages = normalizeAnthropicMessages(messages);
    const internalToolChoice = normalizeAnthropicToolChoice(tool_choice);
    const internalModel = normalizeAnthropicModel(model);
    const internalTools = shouldForwardTools(internalModel, tool_choice)
      ? normalizeAnthropicTools(tools)
      : undefined;

    try {
      const { ctx, response } = await ExecutionGateway.execute(tenantId, {
        messages: internalMessages,
        system: normalizedSystem || undefined,
        model: internalModel,
        temperature,
        maxTokens: clampAnthropicMaxTokens(max_tokens),
        stream,
        tools: internalTools,
        toolChoice: internalToolChoice,
      }, stream);

      const msgId = createMessageId();

      if ('stream' in response && response.stream) {
        console.log('[STREAM] Iniciando streaming de resposta ao cliente (Anthropic Compat)');
        setAnthropicSseHeaders(reply);

        writeAnthropicEvent(reply, 'message_start', {
          type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", content: [], model: model || 'auto', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
        });

        try {
          const streamResponse = response as ProviderStream;
          let outputTokens = 0;
          let currentContentBlockIndex = 0;
          let hasSentFirstTextStart = false;
          let toolState = new Map<number, boolean>(); // Tracks if content_block_start for tool has been sent
          
          for await (const chunk of streamResponse.chunks) {
            if (chunk.type === 'delta') {
              if (!hasSentFirstTextStart) {
                writeAnthropicEvent(reply, 'content_block_start', {
                  type: "content_block_start",
                  index: currentContentBlockIndex,
                  content_block: { type: "text", text: "" }
                });
                hasSentFirstTextStart = true;
              }
              writeAnthropicEvent(reply, 'content_block_delta', {
                type: "content_block_delta",
                index: currentContentBlockIndex,
                delta: { type: "text_delta", text: chunk.text || "" }
              });
            } else if (chunk.type === 'tool_calls') {
              if (hasSentFirstTextStart) {
                writeAnthropicEvent(reply, 'content_block_stop', { type: "content_block_stop", index: currentContentBlockIndex });
                currentContentBlockIndex++;
                hasSentFirstTextStart = false; // Reset if we need another text block later (though usually Anthropic separates them)
              }
              
              for (const tc of chunk.toolCalls) {
                const toolIndex = currentContentBlockIndex + tc.index;
                
                if (!toolState.get(toolIndex)) {
                  writeAnthropicEvent(reply, 'content_block_start', {
                    type: "content_block_start",
                    index: toolIndex,
                    content_block: { type: "tool_use", id: tc.id || `toolu_${Date.now()}_${toolIndex}`, name: tc.name, input: {} }
                  });
                  toolState.set(toolIndex, true);
                }
                
                if (tc.arguments) {
                  writeAnthropicEvent(reply, 'content_block_delta', {
                    type: "content_block_delta",
                    index: toolIndex,
                    delta: { type: "input_json_delta", partial_json: tc.arguments }
                  });
                }
              }
            } else if (chunk.type === 'usage') {
                outputTokens = chunk.completionTokens || 0;
            } else if (chunk.type === 'error') {
              writeAnthropicEvent(reply, 'error', {
                type: 'error',
                error: { type: 'api_error', message: chunk.message },
              });
            }
          }
          
          if (hasSentFirstTextStart) {
             writeAnthropicEvent(reply, 'content_block_stop', { type: "content_block_stop", index: currentContentBlockIndex });
          }
          for (const [toolIndex, started] of toolState.entries()) {
             if (started) writeAnthropicEvent(reply, 'content_block_stop', { type: "content_block_stop", index: toolIndex });
          }
          
          writeAnthropicEvent(reply, 'message_delta', {
            type: "message_delta",
            delta: { stop_reason: toolState.size > 0 ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens }
          });

          writeAnthropicEvent(reply, 'message_stop', { type: "message_stop" });
        } finally {
          reply.raw.end();
        }
        return;
      } else {
        const syncResponse = response as any;
        const content = syncResponse.result?.message?.content || syncResponse.result?.text || '';
        const toolCalls = syncResponse.result?.message?.toolCalls || [];
        const contentBlocks: any[] = [];
        if (content) contentBlocks.push({ type: 'text', text: content });
        for (const call of toolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: call.id || `toolu_${Date.now()}_${contentBlocks.length}`,
            name: call.name,
            input: call.arguments || {},
          });
        }
        if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '' });
        const resolvedModel = syncResponse.model || model || 'auto';
        const usage = anthropicUsage(syncResponse.tokens);

        // Alguns providers locais (como Ollama) retornam uma resposta completa
        // mesmo quando o cliente pede streaming. O Claude Desktop exige SSE
        // nesse caso, entao convertemos o resultado sincronizado para a sequencia
        // oficial de eventos Anthropic em vez de devolver JSON comum.
        if (stream) {
          setAnthropicSseHeaders(reply);

          writeAnthropicEvent(reply, 'message_start', {
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', content: [], model: resolvedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } },
          });
          for (const [index, block] of contentBlocks.entries()) {
            if (block.type === 'tool_use') {
              writeAnthropicEvent(reply, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
              writeAnthropicEvent(reply, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
            } else {
              writeAnthropicEvent(reply, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
              writeAnthropicEvent(reply, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
            }
            writeAnthropicEvent(reply, 'content_block_stop', { type: 'content_block_stop', index });
          }
          writeAnthropicEvent(reply, 'message_delta', { type: 'message_delta', delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
          writeAnthropicEvent(reply, 'message_stop', { type: 'message_stop' });
          reply.raw.end();
          return;
        }
        
        return reply.send({
          id: msgId,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          model: resolvedModel,
          stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage,
          _gateway: {
            request_id: request.id,
            trace_id: ctx.traceId,
            execution_id: ctx.executionId,
            provider: (ctx.metrics as any)?.provider,
            cache: ctx.cacheHit,
            mode: ctx.decision?.mode,
            transport: ctx.decision?.transport,
          }
        });
      }
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(err.statusCode || err.status || 500).send({
        type: 'error',
        error: {
          type: 'api_error',
          message: err.message || 'Internal Server Error'
        }
      });
    }
  });
}
