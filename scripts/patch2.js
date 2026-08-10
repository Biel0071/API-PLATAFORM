const fs = require('fs');
let code = fs.readFileSync('/opt/ai-platform/apps/api/src/routes/v1/index.ts', 'utf8');
const route = `
  app.post('/messages', { schema: { tags: ['v1'] } }, async (req, reply) => {
    const { messages, system, model, temperature, max_tokens } = (req.body as any) || {};
    const internalMessages = [...(messages || [])];
    if (system) internalMessages.unshift({ role: 'system', content: system });
    try {
      const response = await execute('chat', { messages: internalMessages, model, temperature, maxTokens: max_tokens } as any, (p) => p.chat({ messages: internalMessages, model, temperature, maxTokens: max_tokens } as any) as any, { tenantId: (req as any).auth?.tenantId, projectId: (req as any).auth?.projectId });
      const result: any = response.result;
      const tokens: any = response.tokens;
      const content = result?.message?.content || result?.text || '';
      return {
        id: "msg_" + Date.now(),
        type: 'message',
        role: 'assistant',
        model: response.model || model || 'auto',
        content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: tokens?.promptTokens || tokens?.prompt_tokens || 0, output_tokens: tokens?.completionTokens || tokens?.completion_tokens || 0 }
      };
    } catch (err: any) {
      return reply.code(err.status || 500).send({ type: 'error', error: { type: 'api_error', message: err.message } });
    }
  });
`;
if (!code.includes("app.post('/messages'")) {
  code = code.replace('  // ---------- Modelos ----------', route + '\n  // ---------- Modelos ----------');
  fs.writeFileSync('/opt/ai-platform/apps/api/src/routes/v1/index.ts', code);
  console.log("PATCHED successfully");
} else {
  console.log("ALREADY PATCHED");
}
