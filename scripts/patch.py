import os
import sys

# We will run this inside the container using docker cp + docker exec

file_path = '/app/apps/api/dist/routes/v1/openai-compat.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix the /v1/chat/completions endpoint
content = content.replace(
    'const tenantId = request.auth?.tenantId;',
    'const tenantId = request.auth?.tenantId;\n'
    '        const internalMessages = messages.map(m => {\n'
    '            if (m.role === "system" && typeof m.content === "string" && m.content.length > 10000) {\n'
    '                return { ...m, content: m.content.substring(0, 10000) + "\\n\\n... [System prompt truncated to fit limits]" };\n'
    '            }\n'
    '            return m;\n'
    '        });\n'
)

content = content.replace(
    'messages, model, temperature, maxTokens: max_tokens',
    'messages: internalMessages, model, temperature, maxTokens: max_tokens'
)

# Fix the /v1/messages endpoint (Anthropic format)
content = content.replace(
    'normalizedMessages.unshift({ role: \'system\', content: systemContent });',
    'if (typeof systemContent === "string" && systemContent.length > 10000) {\n'
    '    systemContent = systemContent.substring(0, 10000) + "\\n\\n... [System prompt truncated to fit limits]";\n'
    '}\n'
    'normalizedMessages.unshift({ role: \'system\', content: systemContent });'
)


with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied successfully.")
