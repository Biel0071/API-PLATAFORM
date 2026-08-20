import { FastifyInstance } from 'fastify';
import { ExecutionGateway } from '../../services/execution-gateway.service';
import { ProviderStream } from '@api-platform/shared';
import { normalizeAnthropicMessages, normalizeAnthropicTools } from './anthropic-compat.mapper';

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

    const internalMessages = normalizeAnthropicMessages(messages, system);
    const internalTools = normalizeAnthropicTools(tools);

    try {
      const { ctx, response } = await ExecutionGateway.execute(tenantId, {
        messages: internalMessages,
        system, // Opcionalmente passar separado se o Gateway der match nisso no futuro
        model,
        temperature,
        maxTokens: max_tokens,
        stream,
        tools: internalTools,
        toolChoice: tool_choice,
      }, stream);

      const msgId = `msg_${Date.now()}`;

      if ('stream' in response && response.stream) {
        console.log('[STREAM] Iniciando streaming de resposta ao cliente (Anthropic Compat)');
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", content: [], model: model || 'auto', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
        })}\n\n`);

        try {
          const streamResponse = response as ProviderStream;
          let outputTokens = 0;
          let currentContentBlockIndex = 0;
          let hasSentFirstTextStart = false;
          let toolState = new Map<number, boolean>(); // Tracks if content_block_start for tool has been sent
          
          for await (const chunk of streamResponse.chunks) {
            if (chunk.type === 'delta') {
              if (!hasSentFirstTextStart) {
                reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: currentContentBlockIndex,
                  content_block: { type: "text", text: "" }
                })}\n\n`);
                hasSentFirstTextStart = true;
              }
              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: currentContentBlockIndex,
                delta: { type: "text_delta", text: chunk.text || "" }
              })}\n\n`);
            } else if (chunk.type === 'tool_calls') {
              if (hasSentFirstTextStart) {
                reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentContentBlockIndex })}\n\n`);
                currentContentBlockIndex++;
                hasSentFirstTextStart = false; // Reset if we need another text block later (though usually Anthropic separates them)
              }
              
              for (const tc of chunk.toolCalls) {
                const toolIndex = currentContentBlockIndex + tc.index;
                
                if (!toolState.get(toolIndex)) {
                  reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: toolIndex,
                    content_block: { type: "tool_use", id: tc.id || `toolu_${Date.now()}_${toolIndex}`, name: tc.name, input: {} }
                  })}\n\n`);
                  toolState.set(toolIndex, true);
                }
                
                if (tc.arguments) {
                  reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: toolIndex,
                    delta: { type: "input_json_delta", partial_json: tc.arguments }
                  })}\n\n`);
                }
              }
            } else if (chunk.type === 'usage') {
                outputTokens = chunk.completionTokens || 0;
            }
          }
          
          if (hasSentFirstTextStart) {
             reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentContentBlockIndex })}\n\n`);
          }
          for (const [toolIndex, started] of toolState.entries()) {
             if (started) reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: toolIndex })}\n\n`);
          }
          
          reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: toolState.size > 0 ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens }
          })}\n\n`);

          reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
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
        const resolvedModel = syncResponse.model || model || 'auto';
        const inputTokens = syncResponse.tokens?.prompt || 0;
        const outputTokens = syncResponse.tokens?.completion || 0;

        // Alguns providers locais (como Ollama) retornam uma resposta completa
        // mesmo quando o cliente pede streaming. O Claude Desktop exige SSE
        // nesse caso, entao convertemos o resultado sincronizado para a sequencia
        // oficial de eventos Anthropic em vez de devolver JSON comum.
        if (stream) {
          reply.raw.setHeader('Content-Type', 'text/event-stream');
          reply.raw.setHeader('Cache-Control', 'no-cache');
          reply.raw.setHeader('Connection', 'keep-alive');
          reply.raw.flushHeaders();

          reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', content: [], model: resolvedModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
          })}\n\n`);
          for (const [index, block] of contentBlocks.entries()) {
            if (block.type === 'tool_use') {
              reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}\n\n`);
              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}\n\n`);
            } else {
              reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`);
              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}\n\n`);
            }
            reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
          }
          reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
          reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
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
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens
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
