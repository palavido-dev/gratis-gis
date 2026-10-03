'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Mic, Square } from 'lucide-react';

interface BuiltItem {
  id: string;
  type: string;
  title: string;
}

interface BuildResponse {
  summary: string;
  created: BuiltItem[];
}

const TYPE_LABEL: Record<string, string> = {
  data_layer: 'Data layer',
  map: 'Map',
  form: 'Form',
  web_app: 'Web app',
};

type SpeechCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * One description, spoken or typed, becomes the layers, map,
 * form, and app the model planned. The microphone uses the
 * browser's speech engine and only fills the text box.
 */
export function BuildComposer() {
  const [instruction, setInstruction] = useState('');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResponse | null>(null);
  const [speechNote, setSpeechNote] = useState<string | null>(null);
  const recognition = useRef<{ stop: () => void } | null>(null);

  function toggleMic() {
    if (recognition.current) {
      recognition.current.stop();
      recognition.current = null;
      setListening(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      setSpeechNote('This browser has no speech recognition. Type the description instead.');
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript ?? '';
      if (said) {
        setInstruction((prev) => (prev ? `${prev.trim()} ${said}` : said));
      }
    };
    rec.onerror = () => {
      recognition.current = null;
      setListening(false);
    };
    rec.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = rec;
    setListening(true);
    setSpeechNote(null);
    try {
      rec.start();
    } catch {
      setListening(false);
      setSpeechNote('The microphone did not start. Type the description instead.');
    }
  }

  async function submit() {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portal/ai/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: text }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        summary?: string;
        created?: BuiltItem[];
      };
      if (!res.ok) {
        setError(
          body.code === 'ai_not_configured'
            ? 'An organization admin needs to connect an AI provider before this can build anything.'
            : body.message || 'The build did not finish.',
        );
        return;
      }
      setResult({
        summary: body.summary || 'Created.',
        created: body.created ?? [],
      });
    } catch {
      setError('The build did not finish.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <label className="block text-sm font-medium text-ink-0" htmlFor="build-instruction">
        Describe what you want
      </label>
      <textarea
        id="build-instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={5}
        maxLength={4000}
        placeholder="A map of park benches, a form to report a broken bench, and an app that shows both."
        className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-ink-0"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleMic}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-ink-0 hover:bg-surface-2"
        >
          {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {listening ? 'Listening…' : 'Speak'}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || instruction.trim().length === 0}
          className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground disabled:opacity-50"
        >
          {busy ? 'Building…' : 'Build it'}
        </button>
      </div>
      {speechNote ? <p className="text-sm text-muted">{speechNote}</p> : null}
      {error ? <p className="text-sm text-ink-0">{error}</p> : null}
      {result ? (
        <div className="rounded-md border border-border bg-surface-1 p-4">
          <p className="text-sm text-ink-0">{result.summary}</p>
          <ul className="mt-3 space-y-2">
            {result.created.map((item) => (
              <li key={item.id}>
                <Link href={`/items/${item.id}`} className="text-sm text-accent underline">
                  {TYPE_LABEL[item.type] ?? item.type}: {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
