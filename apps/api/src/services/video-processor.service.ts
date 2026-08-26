import ffmpeg from 'fluent-ffmpeg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../lib/logger';

export interface VideoProcessingResult {
  frames: string[]; // Base64 data uris (e.g., data:image/jpeg;base64,...)
  audioPath?: string;
  duration?: number;
}

export class VideoProcessorService {
  /**
   * Extrai keyframes de um vídeo em intervalos regulares.
   * Por padrão, extrai 1 frame por segundo.
   */
  static async extractFrames(videoPath: string, fps: number = 1): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const outDir = path.join(os.tmpdir(), `video-frames-${randomUUID()}`);
      fs.mkdirSync(outDir, { recursive: true });

      logger.info({ videoPath, outDir }, 'Iniciando extração de frames do vídeo');

      ffmpeg(videoPath)
        .on('end', () => {
          logger.info('Extração concluída');
          try {
            const files = fs.readdirSync(outDir).sort();
            const framesBase64: string[] = [];
            
            for (const file of files) {
              const filePath = path.join(outDir, file);
              const data = fs.readFileSync(filePath);
              const base64 = data.toString('base64');
              framesBase64.push(`data:image/jpeg;base64,${base64}`);
            }
            
            // Cleanup
            fs.rmSync(outDir, { recursive: true, force: true });
            resolve(framesBase64);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          logger.error({ err }, 'Erro ao extrair frames');
          fs.rmSync(outDir, { recursive: true, force: true });
          reject(err);
        })
        .screenshots({
          count: undefined, // Ignorado ao usar timestamps ou %b
          folder: outDir,
          filename: 'frame-%i.jpg',
          size: '512x?', // Resize to fit context windows better
          timemarks: this.generateTimestampsForFps(fps),
        });
    });
  }

  // Gera um array simulado de timemarks para 1 frame por segundo, assumindo que limitaremos a uns 60 frames max
  // Para FFmpeg screenshots options, usar 'fps=1' no outputOptions é melhor.
  static async extractFramesAdvanced(videoPath: string, maxFrames: number = 20): Promise<string[]> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          logger.error({ err }, 'Erro ao sondar vídeo com ffprobe');
          return reject(err);
        }

        const duration = metadata.format.duration || 10; // Fallback para 10s se não detectar
        
        // Exemplo: se o vídeo tem 60 segundos e queremos max 20 frames,
        // precisamos de 20/60 = 0.33 frames por segundo (1 frame a cada 3 segundos).
        let dynamicFps = maxFrames / duration;
        
        // Se o cálculo der mais de 1 FPS (vídeos curtos), capeamos em 1 FPS
        // para não extrair milhares de frames em vídeos pequenos.
        if (dynamicFps > 1) dynamicFps = 1;

        const outDir = path.join(os.tmpdir(), `video-frames-${randomUUID()}`);
        fs.mkdirSync(outDir, { recursive: true });

        logger.info({ videoPath, outDir, duration, dynamicFps, maxFrames }, 'Iniciando extração avançada de frames com taxa dinâmica');

        ffmpeg(videoPath)
          .outputOptions([
            // Usamos a taxa dinâmica calculada baseada na duração e limite
            '-vf', `fps=${dynamicFps.toFixed(3)},scale=512:-1`,
            '-q:v', '5'
          ])
          .output(`${outDir}/frame-%04d.jpg`)
          .on('end', () => {
            try {
              const files = fs.readdirSync(outDir).sort();
              
              const framesBase64: string[] = [];
              for (let i = 0; i < Math.min(files.length, maxFrames); i++) {
                const filePath = path.join(outDir, files[i]);
                const data = fs.readFileSync(filePath);
                const base64 = data.toString('base64');
                framesBase64.push(`data:image/jpeg;base64,${base64}`);
              }
              
              fs.rmSync(outDir, { recursive: true, force: true });
              resolve(framesBase64);
            } catch (error) {
              reject(error);
            }
          })
          .on('error', (err) => {
            logger.error({ err }, 'Erro ao extrair frames avançados');
            fs.rmSync(outDir, { recursive: true, force: true });
            reject(err);
          })
          .run();
      });
    });
  }

  private static generateTimestampsForFps(fps: number): string[] {
    return Array.from({ length: 60 }, (_, i) => String(i / fps));
  }
}
