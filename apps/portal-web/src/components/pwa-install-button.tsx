'use client';

import { useEffect, useState } from 'react';
import { Smartphone, X } from 'lucide-react';

/**
 * "Install GratisGIS" affordance for the field runtime + items list.
 *
 * Two paths:
 *
 *   1. **Android Chrome / Edge / Samsung Internet**: capture the
 *      `beforeinstallprompt` event the browser fires when the page
 *      meets the install criteria (manifest + SW + HTTPS + user
 *      engagement signals). Show a button; on click, call
 *      `prompt()` and surface the result.
 *
 *   2. **iOS Safari**: there's no programmatic install, but iOS
 *      gets the strongest benefit from being installed (lifts the
 *      ~1 GB storage cap, gets stronger eviction protection). We
 *      detect iOS and show a static hint with the Share -> Add to
 *      Home Screen instruction.
 *
 * The button hides itself entirely when:
 *   - The page is already running as an installed PWA
 *     (display-mode: standalone matches).
 *   - The user dismissed it once (sessionStorage flag, doesn't
 *     persist across browser restarts so they can still install
 *     later if they change their mind).
 *
 * Slot the component in field-runtime's header so it shows up
 * exactly where install matters most, but it's safe to drop into
 * any client surface (it self-decides whether to render).
 */

// The shape of `beforeinstallprompt` (which TypeScript doesn't know
// natively because it's a non-standard but widely-supported event).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'gratisgis:pwa-install-dismissed';

export function PwaInstallButton({
  variant = 'default',
}: {
  /** 'compact' renders a small icon-only chip suitable for header
   *  bars; 'default' is a labeled button for sidebar / banner use. */
  variant?: 'default' | 'compact';
}) {
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSHint, setShowIOSHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Already installed? Hide forever in this session.
    if (window.matchMedia?.('(display-mode: standalone)').matches) {
      setIsStandalone(true);
      return;
    }
    // Or running inside an iOS PWA shell.
    if (
      'standalone' in window.navigator &&
      (window.navigator as { standalone?: boolean }).standalone === true
    ) {
      setIsStandalone(true);
      return;
    }

    // Was the prompt dismissed this session? Honour that.
    try {
      if (sessionStorage.getItem(DISMISSED_KEY) === '1') {
        setDismissed(true);
      }
    } catch {
      /* sessionStorage unavailable — treat as not-dismissed */
    }

    // iOS detection. Apple kept Safari's UA conservative (and other
    // iOS browsers all wrap WebKit), so the simplest reliable test is
    // platform + touch. iPad on iPadOS 13+ reports as macOS, so also
    // sniff for the touch-capable variant.
    const ua = window.navigator.userAgent;
    const platform = window.navigator.platform || '';
    const isIOSDevice =
      /iPhone|iPad|iPod/.test(platform) ||
      (ua.includes('Mac') && 'ontouchend' in document);
    setIsIOS(isIOSDevice);

    // Capture the Android-side install event. Browsers fire it when
    // they decide the user is "engaged enough" to merit prompting.
    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // Detect post-install so the button hides cleanly without a
    // full reload.
    function onInstalled() {
      setIsStandalone(true);
      setInstallPrompt(null);
    }
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (isStandalone || dismissed) return null;
  // No install path? Hide. (Older browsers, embedded WebViews, etc.)
  if (!installPrompt && !isIOS) return null;

  function handleClick() {
    if (installPrompt) {
      void installPrompt.prompt().then(() => {
        // Whether accepted or dismissed, drop the captured event:
        // the spec says it can only be used once.
        setInstallPrompt(null);
      });
      return;
    }
    if (isIOS) {
      setShowIOSHint(true);
    }
  }

  function dismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      {variant === 'compact' ? (
        <button
          type="button"
          onClick={handleClick}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 text-[11px] font-medium text-accent hover:bg-accent/20"
          title={
            isIOS
              ? 'Install GratisGIS on this device (Tap Share, then Add to Home Screen)'
              : 'Install GratisGIS on this device for offline-friendly storage'
          }
        >
          <Smartphone className="h-3 w-3" />
          Install
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <Smartphone className="h-4 w-4 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-ink-1">
              Install GratisGIS for better offline support
            </p>
            <p className="text-[11px] text-muted">
              {isIOS
                ? 'iOS lifts its 1 GB storage cap once installed.'
                : "Adds an icon to your home screen and protects cached data from cleanup."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClick}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            Install
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {showIOSHint ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install on iOS"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => setShowIOSHint(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl border border-border bg-surface-1 p-4 shadow-overlay"
          >
            <h2 className="text-base font-semibold text-ink-0">
              Install on iOS
            </h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-1">
              <li>
                Tap the <strong>Share</strong> button at the bottom of Safari
                (the square with an up-arrow).
              </li>
              <li>
                Scroll down and tap{' '}
                <strong>Add to Home Screen</strong>.
              </li>
              <li>Tap <strong>Add</strong> in the top-right corner.</li>
            </ol>
            <p className="mt-3 text-xs text-muted">
              Once installed, GratisGIS gets stronger storage retention and
              the iOS 1 GB cap on web storage no longer applies.
            </p>
            <button
              type="button"
              onClick={() => setShowIOSHint(false)}
              className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
