export type RecordingSource = 'microphone' | 'tab-audio';

export interface RecorderHandle {
  stop: () => Promise<Blob>;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
  elapsedSec: () => number;
}

/**
 * Start recording. 'microphone' captures the mic; 'tab-audio' asks the user to share a
 * tab/window WITH audio (how you capture a browser-based Zoom/Meet call) and mixes the
 * mic in so both sides of the conversation are captured.
 */
export async function startRecording(source: RecordingSource): Promise<RecorderHandle> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  let stream = mic;
  let displayStream: MediaStream | null = null;

  if (source === 'tab-audio') {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const displayAudio = displayStream.getAudioTracks();
    if (displayAudio.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      mic.getTracks().forEach((t) => t.stop());
      throw new Error('No tab audio was shared. Pick a tab and enable "Also share tab audio" in the share dialog.');
    }
    // Mix mic + tab audio into one stream.
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(dest);
    ctx.createMediaStreamSource(new MediaStream(displayAudio)).connect(dest);
    stream = dest.stream;
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(1000);

  let startedAt = Date.now();
  let accumulatedMs = 0;
  let paused = false;

  function cleanup() {
    mic.getTracks().forEach((t) => t.stop());
    displayStream?.getTracks().forEach((t) => t.stop());
  }

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          cleanup();
          resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.stop();
      }),
    pause: () => {
      if (!paused && recorder.state === 'recording') {
        recorder.pause();
        accumulatedMs += Date.now() - startedAt;
        paused = true;
      }
    },
    resume: () => {
      if (paused && recorder.state === 'paused') {
        recorder.resume();
        startedAt = Date.now();
        paused = false;
      }
    },
    isPaused: () => paused,
    elapsedSec: () => (accumulatedMs + (paused ? 0 : Date.now() - startedAt)) / 1000,
  };
}
