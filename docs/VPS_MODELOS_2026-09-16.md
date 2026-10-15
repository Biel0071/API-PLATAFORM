# Modelos na VPS .22 — 16/09/2026

## Escopo e estado

Instalação autorizada na VPS `209.50.241.22`, acessada como `deploy`.
Recursos medidos: 4 vCPUs, 5920 MiB de RAM, 4 GiB de swap, sem GPU de IA.
Ollama 0.31.2. Antes: aproximadamente 2,6 GiB disponíveis e carga de CPU alta.
Depois dos downloads: aproximadamente 19 GiB de disco livre.

Workspace de referência: branch `main`, commit `f5bb984b30272aff100907305fb48be32cdb77a0`.
Havia alterações locais prévias; nenhum deploy de código, build, commit, alteração de
modelo padrão ou reinício dos serviços foi realizado. Os containers existentes
permaneceram em execução e reportavam healthy na checagem posterior à instalação.
Esse health não comprova integração com os modelos.

## Instalação e testes

| Modelo | Estado | Evidência |
|---|---|---|
| qwen2.5:0.5b | Já instalado, preservado | Catálogo Ollama |
| qwen2.5:3b | Já instalado, preservado | Catálogo Ollama |
| deepseek-r1:1.5b | Instalado, não aprovado para produção | Download completo; teste de aritmética excedeu 240,17 s |
| qwen3.5:0.8b | Instalado, smoke de texto aprovado | Respondeu `42` para `17 + 25`, em 49,21 s incluindo carregamento |

Teste adicional de visão: PNG uniforme vermelho de 64 × 64 pixels, produzido
programaticamente como fixture. O modelo respondeu `verde` em 49,30 s. Portanto,
o suporte declarado a visão não passou neste smoke; não anunciar visão/OCR validado.
Evidência: `~/model-audit/qwen3.5-0.8b-vision.json`.

Testes sequenciais, CPU, duas threads, contexto 2048, `keep_alive: 0` para descarregar
após a requisição. Qwen com `think: false`. Um smoke não é avaliação geral de qualidade
nem teste de capacidade concorrente. Não foi instalado Kimi: os modelos completos
considerados excedem substancialmente os recursos desta VPS.

## Integração pendente

O container `grg-fenix-enterprise-api-1` tem `FENIX_ENABLE_OLLAMA=1` e
`FENIX_OLLAMA_URL=http://ollama:11434`, mas esse hostname retorna `ENOTFOUND`.
Sondas HTTP internas para `172.17.0.1`, `172.20.0.1` e `172.21.0.1` retornaram
`EHOSTUNREACH`. O Ollama responde no host por `127.0.0.1:11434`.

O provider padrão do FÊNIX é `aiplatform`, não Ollama. Portanto instalar os modelos
não alterou automaticamente o caminho de inferência da aplicação. A integração
autenticada de ponta a ponta continua pendente; falha registrada em `TODO-BUGS.md`.
O acesso `sudo -n` do usuário usado não está disponível. Nenhuma porta pública,
regra de firewall ou permissão administrativa foi alterada.

## Uso local na VPS

Exemplo para executar no host por SSH, sem publicar o Ollama na internet:

```sh
curl http://127.0.0.1:11434/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5:0.8b","messages":[{"role":"user","content":"Explique o que e uma API em uma frase."}],"think":false,"stream":false,"keep_alive":0,"options":{"num_ctx":2048,"num_thread":2,"num_predict":64}}'
```

## Evidências e reversão

Inventário anterior: `~/model-audit/before.txt` e arquivos `*-before.json` na VPS.
Resultados bem-sucedidos: `~/model-audit/qwen3.5-0.8b-test.json`.
Script reproduzível no workspace: `scripts/vps-model-capacity-check.py`.
O timeout DeepSeek foi capturado na saída da execução; não há arquivo de resultado
desse primeiro teste, que precedeu a gravação de erros no script.

Para reverter somente os downloads deste trabalho, após confirmar que não estão em
uso: `ollama rm deepseek-r1:1.5b` e `ollama rm qwen3.5:0.8b`. Os modelos anteriores
e as configurações da aplicação não foram modificados.

Fontes oficiais: https://ollama.com/library/deepseek-r1:1.5b,
https://ollama.com/library/qwen3.5:0.8b,
https://huggingface.co/moonshotai/Kimi-K2-Instruct.
