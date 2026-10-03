'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Mic, Square } from 'lucide-react';

interface LayerChoice {
  id: string;
  label: string;
}

interface LayerItem {
  id: string;
  title: string;
  layers: LayerChoice[];
}

interface AskHit {
  id: string;
  attributes: Record<string, string>;
}

interface AskResponse {
  answer: string;
  layerId: string;
  sampled: number;
  features: AskHit[];
}

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
 * Ask about rows on a data layer. The server sends a short
 * sample of attribute text to the configured model and only
 * returns ids from that sample.
 */
export function LayerAsk() {
  const [items, setItems] = useState<LayerItem[] | null>(null);
  const [itemId, setItemId] = useState('');
  const [layerId, setLayerId] = useState('');
  const [question, setQuestion] = useState('');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speechNote, setSpeechNote] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const recognition = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=data_layer&full=1&limit=30');
        if (!res.ok) {
          if (!cancelled) setItems([]);
          return;
        }
        const rows = (await res.json()) as Array<{
          id: string;
          title: string;
          data?: { layers?: Array<{ id?: string; label?: string }> };
        }>;
        if (cancelled) return;
        const next = rows
          .map((row) => ({
            id: row.id,
            title: row.title,
            layers: (row.data?.layers ?? [])
              .filter((layer): layer is { id: string; label?: string } => typeof layer.id === 'string')
              .map((layer) => ({ id: layer.id, label: layer.label || layer.id })),
          }))
          .sort((a, b) => a.title.localeCompare(b.title));
        setItems(next);
        const first = next[0];
        if (first) {
          setItemId(first.id);
          const layer = first.layers[0];
          if (layer) setLayerId(layer.id);
        }
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = items?.find((item) => item.id === itemId) ?? null;

  function toggleMic() {
    if (recognition.current) {
      recognition.current.stop();
      recognition.current = null;
      setListening(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      setSpeechNote('This browser has no speech recognition. Type the question instead.');
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript ?? '';
      if (said) setQuestion((prev) => (prev ? `${prev.trim()} ${said}` : said));
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
      setSpeechNote('The microphone did not start. Type the question instead.');
    }
  }

  async function submit() {
    const text = question.trim();
    if (!text || !itemId || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portal/ai/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId,
          question: text,
          ...(layerId ? { layerId } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as AskResponse & {
        message?: string;
        code?: string;
      };
      if (!res.ok) {
        setError(
          body.code === 'ai_not_configured'
            ? 'An organization admin needs to connect an AI provider before a layer can be asked.'
            : body.message || 'The question did not finish.',
        );
        return;
      }
      setResult({
        answer: body.answer,
        layerId: body.layerId,
        sampled: body.sampled,
        features: body.features ?? [],
      });
    } catch {
      setError('The question did not finish.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-ink-0">Ask a layer</h2>
      <p className="text-sm text-ink-1">
        Ask about rows on a data layer you can already open. GratisGIS
        searches attribute text for words in the question, then asks
        the model about that sample. Geometries are not sent. The
        answer can only name rows from the sample.
      </p>
      {items === null ? (
        <p className="text-sm text-muted">Loading layers…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No data layers are available to ask.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-ink-0">
            Data layer
            <select
              value={itemId}
              onChange={(event) => {
                const nextId = event.target.value;
                setItemId(nextId);
                const next = items.find((item) => item.id === nextId);
                setLayerId(next?.layers[0]?.id ?? '');
                setResult(null);
              }}
              className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-2 text-sm text-ink-0"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {selected && selected.layers.length > 1 ? (
            <label className="block text-sm text-ink-0">
              Layer
              <select
                value={layerId}
                onChange={(event) => {
                  setLayerId(event.target.value);
                  setResult(null);
                }}
                className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-2 text-sm text-ink-0"
              >
                {selected.layers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      )}
      <label className="block text-sm font-medium text-ink-0" htmlFor="layer-question">
        Question
      </label>
      <textarea
        id="layer-question"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        rows={3}
        maxLength={500}
        placeholder="Which benches are marked broken?"
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
          disabled={busy || question.trim().length === 0 || !itemId}
          className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground disabled:opacity-50"
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {speechNote ? <p className="text-sm text-muted">{speechNote}</p> : null}
      {error ? <p className="text-sm text-ink-0">{error}</p> : null}
      {result ? (
        <div className="rounded-md border border-border bg-surface-1 p-4">
          <p className="text-sm text-ink-0">{result.answer}</p>
          <p className="mt-2 text-xs text-muted">
            Sampled {result.sampled} row{result.sampled === 1 ? '' : 's'}.{' '}
            <Link href={`/items/${itemId}`} className="text-accent underline">
              Open the layer
            </Link>
          </p>
          {result.features.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {result.features.map((feature) => (
                <li key={feature.id} className="text-sm text-ink-1">
                  <span className="font-mono text-xs">{feature.id}</span>
                  {Object.entries(feature.attributes).length > 0 ? (
                    <span>
                      {' '}
                      — {Object.entries(feature.attributes).map(([key, value]) => `${key}: ${value}`).join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
