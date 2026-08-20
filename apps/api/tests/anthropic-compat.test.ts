import { describe, expect, it } from 'vitest';
import { anthropicContentToText, normalizeAnthropicMessages, normalizeAnthropicTools } from '../src/routes/v1/anthropic-compat.mapper';

describe('Anthropic compatibility mapper', () => {
  it('normalizes text and tool result content blocks', () => {
    expect(anthropicContentToText([
      { type: 'text', text: 'oi' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'feito' }] },
    ])).toContain('oi');
    expect(anthropicContentToText([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'feito' }])).toContain('feito');
  });

  it('normalizes array system prompts and messages to strings', () => {
    const messages = normalizeAnthropicMessages(
      [{ role: 'user', content: [{ type: 'text', text: 'teste' }] }],
      [{ type: 'text', text: 'sistema' }],
    );
    expect(messages).toEqual([
      { role: 'system', content: 'sistema' },
      { role: 'user', content: 'teste' },
    ]);
  });

  it('maps Anthropic tools to function tools', () => {
    const tools = normalizeAnthropicTools([{ name: 'read_file', description: 'Read', input_schema: { type: 'object' } }]);
    expect(tools?.[0]).toMatchObject({ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } });
  });
});
