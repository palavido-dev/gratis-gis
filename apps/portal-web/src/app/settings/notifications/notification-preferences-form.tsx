'use client';

import { useMemo, useState } from 'react';
import { Mail, Loader2 } from 'lucide-react';

interface PreferenceState {
  enabled: boolean;
  isDefault: boolean;
}

interface NotificationTypeView {
  type: string;
  category: string;
  label: string;
  description: string;
  channels: ('email')[];
  preferences: Record<'email', PreferenceState>;
}

interface PreferencesPayload {
  channels: ('email')[];
  types: NotificationTypeView[];
}

interface Props {
  initial: PreferencesPayload;
}

const CATEGORY_LABEL: Record<string, string> = {
  sharing: 'Sharing',
  account: 'Account',
  editor: 'Editor activity',
};

/**
 * Per-(type, channel) toggles the user can flip. Each toggle does
 * an optimistic local update and PUTs the change. On error we
 * revert and surface the message inline.
 *
 * We display a small "default" tag next to defaulted rows so users
 * understand a freshly-flipped preference is now an explicit
 * override -- and a row that returns to its default value drops
 * the override at the server (the backend deletes the row when
 * `enabled === default`).
 */
export function NotificationPreferencesForm({ initial }: Props) {
  const [types, setTypes] = useState(initial.types);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  // Group the catalog by category so we can render section headers
  // without the UI hard-coding the category list. Order within each
  // group preserves the server's catalog order (which is curated).
  const grouped = useMemo(() => {
    const groups = new Map<string, NotificationTypeView[]>();
    for (const t of types) {
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    return groups;
  }, [types]);

  async function toggle(
    type: string,
    channel: 'email',
    nextEnabled: boolean,
  ) {
    const key = `${type}|${channel}`;
    // Optimistic local update so the toggle feels instant.
    const prevTypes = types;
    setTypes((cur) =>
      cur.map((t) =>
        t.type === type
          ? {
              ...t,
              preferences: {
                ...t.preferences,
                [channel]: {
                  enabled: nextEnabled,
                  // We don't yet know if the new value matches the
                  // server-side default; assume not until the response
                  // comes back. That's a benign assumption: if it does
                  // match the default, the response replaces the state
                  // with isDefault: true on the next render.
                  isDefault: false,
                },
              },
            }
          : t,
      ),
    );
    setSavingKey(key);
    setErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const res = await fetch(
        '/api/portal/users/me/notification-preferences',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type, channel, enabled: nextEnabled }),
        },
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as PreferenceState;
      // Replace with server-confirmed state (which may flip
      // isDefault back to true if the new value matched the default
      // and the row was deleted).
      setTypes((cur) =>
        cur.map((t) =>
          t.type === type
            ? {
                ...t,
                preferences: { ...t.preferences, [channel]: body },
              }
            : t,
        ),
      );
    } catch (err) {
      // Revert on failure so the UI matches reality.
      setTypes(prevTypes);
      setErrorByKey((prev) => ({
        ...prev,
        [key]:
          err instanceof Error ? err.message : 'Could not save change.',
      }));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-8">
      {[...grouped.entries()].map(([category, items]) => (
        <section key={category}>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <ul className="space-y-1.5">
            {items.map((t) => (
              <li
                key={t.type}
                className="rounded-md border border-border bg-surface-1 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-0">
                      {t.label}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {t.channels.map((channel) => {
                      const pref = t.preferences[channel];
                      const key = `${t.type}|${channel}`;
                      const saving = savingKey === key;
                      const error = errorByKey[key];
                      return (
                        <div
                          key={channel}
                          className="flex items-center gap-2"
                        >
                          <Mail className="h-3.5 w-3.5 text-muted" />
                          <span className="text-xs text-muted">
                            {channel}
                          </span>
                          {pref.isDefault ? (
                            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                              default
                            </span>
                          ) : null}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={pref.enabled}
                            disabled={saving}
                            onClick={() =>
                              void toggle(t.type, channel, !pref.enabled)
                            }
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                              pref.enabled
                                ? 'bg-accent'
                                : 'bg-surface-2 ring-1 ring-inset ring-border'
                            }`}
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                                pref.enabled
                                  ? 'translate-x-5'
                                  : 'translate-x-1'
                              }`}
                            />
                            {saving ? (
                              <Loader2 className="absolute inset-0 m-auto h-3 w-3 animate-spin text-white" />
                            ) : null}
                          </button>
                        </div>
                      );
                    })}
                    {Object.entries(errorByKey).find(([k]) =>
                      k.startsWith(`${t.type}|`),
                    ) ? (
                      <p
                        className="text-[11px] text-danger"
                        role="alert"
                      >
                        {Object.entries(errorByKey).find(([k]) =>
                          k.startsWith(`${t.type}|`),
                        )?.[1]}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
