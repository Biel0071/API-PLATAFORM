# Engine local de áudio

O serviço só é iniciado com `docker compose --profile audio up -d audio-engine` e não publica portas. A API e o worker o acessam pela rede privada do Compose.

O serviço usa faster-whisper `base` em CPU/int8 para STT e Kokoro ONNX com G2P `pt-br` para TTS. Antes de iniciar, coloque `kokoro-v1.0.onnx` e `voices-v1.0.bin` no volume `audio-models`, usando os arquivos publicados pelo projeto [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx). O modelo Whisper é baixado pelo faster-whisper na primeira transcrição; isso baixa somente pesos, nunca áudio do usuário.

O perfil `audio` permanece opt-in. Meça disco, RAM, latência e OOM na VPS antes de habilitá-lo; não aumente memória nem remova imagens Docker do host sem revisar capacidade e rollback. Clonagem (Chatterbox/VoxCPM2) não está habilitada; amostras salvas não são usadas como vozes clonadas.
