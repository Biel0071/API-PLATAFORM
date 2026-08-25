import ffmpeg from 'fluent-ffmpeg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../plugins/logger';

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
      const outDir = path.join(os.tmpdir(), `video-frames-${randomUUID()}`);
      fs.mkdirSync(outDir, { recursive: true });

      logger.info({ videoPath, outDir }, 'Iniciando extração avançada de frames');

      // Extrai a 1 frame por segundo
      ffmpeg(videoPath)
        .outputOptions([
          '-vf', 'fps=1,scale=512:-1',
          '-q:v', '5'
        ])
        .output(`${outDir}/frame-%04d.jpg`)
        .on('end', () => {
          try {
            const files = fs.readdirSync(outDir).sort();
            
            // Se tivermos mais frames que o máximo, amostramos uniformemente
            let selectedFiles = files;
            if (files.length > maxFrames) {
              const step = files.length / maxFrames;
              selectedFiles = [];
              for (let i = 0; i < maxFrames; i++) {
                selectedFiles.push(files[Math.floor(i * step)]);
              }
            }
            
            const framesBase64: string[] = [];
            for (const file of selectedFiles) {
              const filePath = path.join(outDir, file);
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
  }

  private static generateTimestampsForFps(fps: number): string[] {
    return Array.from({ length: 60 }, (_, i) => String(i / fps));
  }
}
