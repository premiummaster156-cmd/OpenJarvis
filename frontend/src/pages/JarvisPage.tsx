import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX, Waves } from 'lucide-react';
import { useSpeech } from '../hooks/useSpeech';
import { streamChat } from '../lib/sse';
import { synthesizeSpeech } from '../lib/api';
import { useAppStore } from '../lib/store';

type Turn = { role: 'user' | 'assistant'; content: string };

export function JarvisPage() {
  const selectedModel = useAppStore((s) => s.selectedModel);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('Standing by');
  const [busy, setBusy] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [callMode, setCallMode] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { state: speechState, available: speechAvailable, error: speechError, startRecording, stopRecording } = useSpeech();

  useEffect(() => () => {
    abortRef.current?.abort();
    if (audioRef.current) audioRef.current.pause();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const speak = useCallback(async (text: string) => {
    if (!voiceEnabled || !text.trim()) return;
    try {
      setStatus('Speaking');
      const blob = await synthesizeSpeech(text, { voiceId: 'bm_george' });
      const url = URL.createObjectURL(blob);
      setAudioUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setStatus(callMode ? 'Call connected' : 'Standing by');
      await audio.play();
    } catch {
      setStatus('Voice output unavailable');
    }
  }, [voiceEnabled, callMode]);

  const send = useCallback(async (raw: string) => {
    const prompt = raw.trim();
    if (!prompt || busy) return;
    if (!selectedModel) {
      setStatus('Select a model in the sidebar first');
      return;
    }
    const nextTurns: Turn[] = [...turns, { role: 'user', content: prompt }];
    setTurns(nextTurns);
    setDraft('');
    setReply('');
    setBusy(true);
    setStatus('Thinking');
    const controller = new AbortController();
    abortRef.current = controller;
    let answer = '';
    try {
      const messages = [
        { role: 'system', content: 'You are JARVIS, a composed, highly capable personal AI assistant. Speak naturally, concisely, and with understated wit. Address the user respectfully. Never claim to perform actions you cannot perform.' },
        ...nextTurns,
      ];
      for await (const event of streamChat({
        model: selectedModel,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 1024,
      }, controller.signal)) {
        try {
          const data = JSON.parse(event.data);
          const chunk = data.choices?.[0]?.delta?.content;
          if (typeof chunk === 'string') {
            answer += chunk;
            setReply(answer);
            setStatus('Generating response');
          }
        } catch {
          // Ignore non-JSON or metadata-only stream events.
        }
      }
      if (answer.trim()) {
        setTurns((current) => [...current, { role: 'assistant', content: answer }]);
        setReply('');
        await speak(answer);
      } else {
        setStatus('No response received');
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus(error instanceof Error ? error.message : 'Connection error');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      if (!audioRef.current) setStatus(callMode ? 'Call connected' : 'Standing by');
    }
  }, [busy, selectedModel, turns, speak, callMode]);

  const toggleMic = async () => {
    if (speechState === 'recording') {
      try {
        const text = await stopRecording();
        if (text) await send(text);
      } catch {
        setStatus('Could not transcribe audio');
      }
    } else {
      await startRecording();
      setStatus('Listening');
    }
  };

  const endCall = () => {
    abortRef.current?.abort();
    audioRef.current?.pause();
    audioRef.current = null;
    setCallMode(false);
    setStatus('Standing by');
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-[#050b12] text-slate-100">
      <div className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: 'radial-gradient(circle at 50% 35%, rgba(8,145,178,.22), transparent 34%), linear-gradient(rgba(34,211,238,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.035) 1px, transparent 1px)', backgroundSize: 'auto, 36px 36px, 36px 36px' }} />
      <header className="relative z-10 flex items-center justify-between border-b border-cyan-300/10 px-5 py-4">
        <div>
          <div className="font-mono text-[10px] tracking-[.35em] text-cyan-300/70">PERSONAL INTELLIGENCE SYSTEM</div>
          <h1 className="mt-1 text-xl font-semibold tracking-[.18em]">J.A.R.V.I.S.</h1>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/5 px-3 py-1.5 text-xs text-cyan-100/80">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" />
          {selectedModel || 'No model selected'}
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col items-center px-5 py-8">
        <div className="relative mt-3 flex h-56 w-56 items-center justify-center">
          <div className={`absolute inset-2 rounded-full border border-cyan-300/20 ${busy || speechState === 'recording' ? 'animate-ping' : ''}`} />
          <div className="absolute inset-5 rounded-full border border-cyan-300/25 shadow-[0_0_55px_rgba(34,211,238,.12)]" />
          <div className="absolute inset-10 rounded-full border border-cyan-200/30" />
          <div className={`relative flex h-28 w-28 items-center justify-center rounded-full border border-cyan-100/50 bg-cyan-300/10 shadow-[0_0_65px_rgba(34,211,238,.35),inset_0_0_35px_rgba(34,211,238,.22)] ${busy || speechState === 'recording' ? 'scale-105' : ''} transition-transform`}>
            <Waves size={42} className="text-cyan-200" strokeWidth={1.2} />
          </div>
        </div>
        <div className="mt-3 font-mono text-xs uppercase tracking-[.32em] text-cyan-200/80">{status}</div>
        {speechError && <p className="mt-2 text-xs text-rose-300">{speechError}</p>}
        <div className="mt-8 w-full max-w-2xl space-y-3">
          {turns.slice(-4).map((turn, index) => (
            <div key={index} className={`rounded-xl border px-4 py-3 text-sm ${turn.role === 'user' ? 'ml-10 border-white/10 bg-white/5 text-slate-200' : 'mr-10 border-cyan-300/15 bg-cyan-300/5 text-cyan-50'}`}>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[.2em] text-cyan-300/60">{turn.role === 'user' ? 'You' : 'JARVIS'}</div>
              {turn.content}
            </div>
          ))}
          {reply && <div className="mr-10 rounded-xl border border-cyan-300/15 bg-cyan-300/5 px-4 py-3 text-sm text-cyan-50">{reply}</div>}
        </div>

        <div className="mt-auto w-full max-w-2xl pt-10">
          <form onSubmit={(event) => { event.preventDefault(); void send(draft); }} className="flex items-center gap-2 rounded-2xl border border-cyan-200/20 bg-slate-900/80 p-2 shadow-[0_10px_50px_rgba(0,0,0,.25)]">
            <button type="button" onClick={() => setVoiceEnabled((value) => !value)} className="rounded-xl p-3 text-cyan-200/70 hover:bg-white/5" title={voiceEnabled ? 'Mute voice replies' : 'Enable voice replies'}>
              {voiceEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Speak or type a command..." className="min-w-0 flex-1 bg-transparent px-2 text-sm text-white outline-none placeholder:text-slate-500" />
            <button type="button" onClick={() => void toggleMic()} disabled={!speechAvailable || busy} className={`rounded-xl p-3 transition-colors ${speechState === 'recording' ? 'bg-rose-500 text-white' : 'text-cyan-200 hover:bg-cyan-300/10'} disabled:opacity-30`} title={speechAvailable ? 'Voice input' : 'Speech backend unavailable'}>
              {speechState === 'recording' ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button type="submit" disabled={!draft.trim() || busy} className="rounded-xl bg-cyan-300 px-4 py-3 text-slate-950 transition-opacity hover:opacity-90 disabled:opacity-30" title="Send command">
              <ArrowUp size={18} />
            </button>
          </form>
          <div className="mt-3 flex items-center justify-between text-[10px] font-mono uppercase tracking-[.15em] text-slate-500">
            <span>Local-first · OpenJarvis engine</span>
            <button onClick={() => { if (callMode) endCall(); else { setCallMode(true); setStatus('Call session active'); } }} className="flex items-center gap-2 rounded-full border border-cyan-300/20 px-3 py-1.5 text-cyan-100/80 hover:bg-cyan-300/10">
              {callMode ? <PhoneOff size={12} /> : <Phone size={12} />}
              {callMode ? 'End session' : 'Start voice session'}
            </button>
          </div>
          <p className="mt-2 text-center text-[10px] text-slate-600">Voice sessions use your browser microphone and speaker. This is not a cellular phone call.</p>
        </div>
      </main>
    </div>
  );
}
