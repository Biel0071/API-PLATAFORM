# FreeLLMs — avaliação para integração

Consulta realizada em 16/09/2026. FreeLLMs (`https://freellms.org/?free=1`)
é um diretório de provedores/modelos e links para gerar chaves nas contas dos
respectivos serviços. Não fornece uma credencial universal. Não confundir com
o adaptador `freellmapi` existente, cujo endpoint padrão é outro domínio,
`https://api.freellmapi.com/v1`.

## Evidência atual dos catálogos oficiais

`GET https://integrate.api.nvidia.com/v1/models` respondeu HTTP 200 sem chave
e listou, entre outros:

- `deepseek-ai/deepseek-coder-6.7b-instruct`
- `deepseek-ai/deepseek-v4-flash-0731`
- `moonshotai/kimi-k2.6`
- `moonshotai/kimi-k3`
- `z-ai/glm-5.3`
- `z-ai/glm-5.3-flash`

Isso prova presença no catálogo público, não acesso autenticado, inferência,
gratuidade, SLA ou cota para a conta do usuário.

`GET https://openrouter.ai/api/v1/models` respondeu HTTP 200. No filtro de
famílias chinesas (Kimi, DeepSeek, Qwen, GLM, MiniMax), `z-ai/glm-5.2:free`
foi retornado com `pricing.prompt = 0` e `pricing.completion = 0`.
O catálogo e as condições podem mudar; confirmar novamente ao ativar.

## Credenciais e código

Nos arquivos locais `.env` e `.env_vps`, há chave Groq configurada. O teste de
catálogo a partir do computador respondeu HTTP 403 com mensagem de bloqueio de
acesso/rede. A mesma consulta a partir da VPS .22 também respondeu HTTP 403.
Não concluir que a chave é inválida apenas por esse resultado.

O registry da API Platform já tem adaptadores para Groq, OpenRouter, Gemini,
Cloudflare e Hugging Face. Não há provider dedicado NVIDIA, Cerebras ou Mistral
nesse registry. O `OpenAICompatibleProvider` existente pode servir como base,
com registro próprio e suporte no formulário administrativo; não reutilizar
a chave Groq em endpoints de outros serviços.

## Sequência proposta

1. Criar chave própria NVIDIA no catálogo oficial, selecionar um modelo e
   validar chamada mínima, latência e limites. Implementar provider `nvidia`
   com base `https://integrate.api.nvidia.com/v1`.
2. Criar chave própria OpenRouter e usar o adaptador existente. Começar com
   modelo de preço zero verificado e fallback restrito a opções gratuitas.
3. Resolver o HTTP 403 do Groq antes de anunciá-lo disponível.
4. Validar pelo gateway autenticado na VPS, incluindo falha, quota, timeout
   e contabilização. A presença dos adaptadores locais não comprova deploy.

Não foram criadas contas, contratados planos, gravadas novas chaves, alteradas
rotas de produção ou realizadas inferências pagas neste levantamento.

## Fontes

- https://freellms.org/free-llm-api-keys
- https://github.com/freellms/free-llm-api-keys
- https://docs.api.nvidia.com/nim/docs/api-quickstart
- https://openrouter.ai/docs/api_reference/limits
- https://console.groq.com/docs/rate-limits

As cotas do diretório não substituem as regras do provedor. Mais chaves na mesma
conta não implicam mais cota; Groq aplica limites por organização e OpenRouter
também documenta limites que não aumentam criando novas chaves.
