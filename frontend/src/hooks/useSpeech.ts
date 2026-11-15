import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

function getRecordingOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined;

  // Safari on iPhone commonly records MP4/AAC, while Chromium commonly
  // records WebM/Opus. Prefer the browser-supported format instead of
  // assuming WebM on every device.
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  const mimeType = candidates.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  return mimeType ? { mimeType } : undefined;
}

function getRecordingFilename(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'recording.m4a';
  if (normalized.includes('ogg')) return 'recording.ogg';
  if (normalized.includes('wav')) return 'recording.wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'recording.mp3';
  return 'recording.webm';
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => setAvailable(health.available))
      .catch(() => setAvailable(false));
  }, []);

  // Always release the phone microphone when the component is unmounted.
  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // The stream tracks below are still stopped even if stop() races.
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Audio recording is not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const options = getRecordingOptions();
      const recorder = options
        ? new MediaRecorder(stream, options)
        : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState('recording');
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Microphone access denied'
        : 'Could not start microphone recording');
      setState('idle');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        setState('transcribing');

        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const mimeType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        mediaRecorderRef.current = null;

        try {
          const result = await transcribeAudio(blob, getRecordingFilename(mimeType));
          setState('idle');
          resolve(result.text);
        } catch (err) {
          setState('idle');
          const message = err instanceof Error ? err.message : 'Transcription failed';
          setError(message);
          reject(err);
        }
      };

      recorder.onerror = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        setState('idle');
        setError('Audio recording failed');
        reject(new Error('Audio recording failed'));
      };

      recorder.stop();
    });
  }, []);

  return {
    state,
    error,
    available,
    startRecording,
    stopRecording,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
