type AnthropicBlock = Record<string, any>;

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

/** Converte content blocks da Messages API em texto aceito por LLMs locais. */
export function anthropicContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyValue(content);

  return content.map((raw: unknown) => {
    if (typeof raw === 'string') return raw;
    const block = (raw && typeof raw === 'object' ? raw : {}) as AnthropicBlock;
    switch (block.type) {
      case 'text':
        return stringifyValue(block.text);
      case 'thinking':
        return stringifyValue(block.thinking);
      case 'tool_use':
        return `[tool_use name=${stringifyValue(block.name)} id=${stringifyValue(block.id)}]\n${stringifyValue(block.input)}`;
      case 'tool_result':
        return `[tool_result id=${stringifyValue(block.tool_use_id)}${block.is_error ? ' error=true' : ''}]\n${anthropicContentToText(block.content)}`;
      case 'image':
        return '[image attached]';
      default:
        return stringifyValue(block.text ?? block.content ?? block);
    }
  }).filter(Boolean).join('\n\n');
}

export function normalizeAnthropicMessages(messages: unknown[], system?: unknown): Array<any> {
  const normalized: any[] = [];
  
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      if (!raw || typeof raw !== 'object') continue;
      const msg = raw as any;
      
      if (msg.role === 'user') {
         if (Array.isArray(msg.content) && msg.content.some((b: any) => b.type === 'tool_result')) {
           for (const block of msg.content) {
              if (block.type === 'tool_result') {
                 normalized.push({
                   role: 'tool',
                   tool_call_id: block.tool_use_id,
                   content: typeof block.content === 'string' ? block.content : anthropicContentToText(block.content),
                   ...(block.is_error ? { is_error: true } : {})
                 });
              } else if (block.type === 'text' && block.text) {
                 normalized.push({ role: 'user', content: block.text });
              } else if (block.type === 'image') {
                 normalized.push({ role: 'user', content: '[image attached]' });
              }
           }
         } else {
           normalized.push({ role: 'user', content: anthropicContentToText(msg.content) });
         }
      } else if (msg.role === 'assistant') {
         let hasToolUse = false;
         let textContent = '';
         const toolCalls: any[] = [];
         
         if (Array.isArray(msg.content)) {
           for (const block of msg.content) {
             if (block.type === 'text') {
               textContent += block.text + '\n';
             } else if (block.type === 'tool_use') {
               hasToolUse = true;
               toolCalls.push({
                 id: block.id,
                 type: 'function',
                 function: {
                   name: block.name,
                   arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
                 }
               });
             }
           }
         } else {
           textContent = anthropicContentToText(msg.content);
         }
         
         const assistantMsg: any = { role: 'assistant', content: textContent.trim() || undefined };
         if (hasToolUse) {
           assistantMsg.tool_calls = toolCalls;
         }
         normalized.push(assistantMsg);
      }
    }
  }

  // System text is handled separately by the gateway.
  return normalized;
}

/** Ollama usa o formato de function tools compativel com OpenAI. */
export function normalizeAnthropicTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((raw: any) => raw?.type === 'function' && raw?.function
    ? raw
    : {
        type: 'function',
        function: {
          name: String(raw?.name ?? ''),
          description: typeof raw?.description === 'string' ? raw.description : undefined,
          parameters: raw?.input_schema ?? { type: 'object', properties: {} },
        },
      });
}

