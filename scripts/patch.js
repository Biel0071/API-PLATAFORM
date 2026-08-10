const fs = require('fs');

const file_path = '/app/apps/api/dist/routes/v1/openai-compat.js';

let content = fs.readFileSync(file_path, 'utf8');

// Fix the /v1/chat/completions endpoint
content = content.replace(
    'const tenantId = request.auth?.tenantId;',
    `const tenantId = request.auth?.tenantId;
        const internalMessages = messages.map(m => {
            if (m.role === "system" && typeof m.content === "string" && m.content.length > 10000) {
                return { ...m, content: m.content.substring(0, 10000) + "\\n\\n... [System prompt truncated to fit limits]" };
            }
            return m;
        });`
);

content = content.replace(
    'messages, model, temperature, maxTokens: max_tokens',
    'messages: internalMessages, model, temperature, maxTokens: max_tokens'
);

// Fix the /v1/messages endpoint (Anthropic format)
content = content.replace(
    "normalizedMessages.unshift({ role: 'system', content: systemContent });",
    `if (typeof systemContent === "string" && systemContent.length > 10000) {
    systemContent = systemContent.substring(0, 10000) + "\\n\\n... [System prompt truncated to fit limits]";
}
normalizedMessages.unshift({ role: 'system', content: systemContent });`
);

fs.writeFileSync(file_path, content);
console.log("Patch applied successfully.");
