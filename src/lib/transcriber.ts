import type { TranscriptSegment } from '../shared/types';

export interface TranscribeProgress {
  phase: 'loading-model' | 'transcribing';
  /** 0..1 where known, otherwise -1 (indeterminate) */
  progress: number;
  detail: string;
}

type ProgressCallback = (p: TranscribeProgress) => void;

// The transformers.js pipeline is heavy (~40MB of JS + model weights), so it is
// imported lazily on first use and cached for the session.
let pipelinePromise: Promise<unknown> | null = null;
let loadedModelId: string | null = null;

async function getPipeline(modelId: string, onProgress: ProgressCallback): Promise<unknown> {
  if (pipelinePromise && loadedModelId === modelId) return pipelinePromise;
  loadedModelId = modelId;
  pipelinePromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const seen = new Map<string, number>();
    return pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
      progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
        if (info.status === 'progress' && info.file && typeof info.progress === 'number') {
          seen.set(info.file, info.progress);
          const values = [...seen.values()];
          const avg = values.reduce((a, b) => a + b, 0) / values.length / 100;
          onProgress({ phase: 'loading-model', progress: avg, detail: `Downloading speech model (${Math.round(avg * 100)}%)` });
        }
      },
    });
  })();
  return pipelinePromise;
}

/** Decode any browser-supported audio (webm/ogg/mp3/wav/m4a) into 16kHz mono PCM. */
export async function decodeAudio(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const probeCtx = new AudioContext();
  const decoded = await probeCtx.decodeAudioData(arrayBuffer);
  await probeCtx.close();

  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();
  return resampled.getChannelData(0).slice();
}

interface ChunkOutput {
  text: string;
  chunks?: { timestamp: [number, number | null]; text: string }[];
}

export async function transcribe(
  blob: Blob,
  modelId: string,
  onProgress: ProgressCallback
): Promise<TranscriptSegment[]> {
  onProgress({ phase: 'loading-model', progress: -1, detail: 'Preparing speech model…' });
  const transcriber = (await getPipeline(modelId, onProgress)) as (
    audio: Float32Array,
    options: Record<string, unknown>
  ) => Promise<ChunkOutput>;

  onProgress({ phase: 'transcribing', progress: -1, detail: 'Decoding audio…' });
  const audio = await decodeAudio(blob);
  const totalSec = audio.length / 16000;

  // Whisper handles 30s windows natively; chunk longer audio ourselves so we can
  // report progress and keep memory bounded.
  const CHUNK_SEC = 28;
  const chunkSamples = CHUNK_SEC * 16000;
  const segments: TranscriptSegment[] = [];

  for (let offset = 0; offset < audio.length; offset += chunkSamples) {
    const chunk = audio.subarray(offset, Math.min(offset + chunkSamples, audio.length));
    const baseTime = offset / 16000;
    onProgress({
      phase: 'transcribing',
      progress: Math.min(offset / audio.length, 0.99),
      detail: `Transcribing… ${Math.round(baseTime)}s / ${Math.round(totalSec)}s`,
    });

    const result = await transcriber(chunk as Float32Array, {
      return_timestamps: true,
      chunk_length_s: 30,
      language: 'english',
      task: 'transcribe',
    });

    if (result.chunks && result.chunks.length > 0) {
      for (const c of result.chunks) {
        const [s, e] = c.timestamp;
        segments.push({ start: baseTime + (s ?? 0), end: baseTime + (e ?? s ?? 0), text: c.text });
      }
    } else if (result.text.trim().length > 0) {
      segments.push({ start: baseTime, end: baseTime + chunk.length / 16000, text: result.text });
    }
  }

  onProgress({ phase: 'transcribing', progress: 1, detail: 'Done' });
  return segments;
}
