// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The bottom sheet every field surface sits in.
 *
 * NOT built on `@/components/ui/dialog`, and the reason is a product
 * decision rather than a shortcut. Radix Dialog is modal: it traps
 * focus, locks scroll, and makes everything behind it inert. These
 * sheets must do the opposite. Field Maps does not dim the map while a
 * collect is in progress, and neither do we: the collector keeps
 * panning, zooming and tapping to move the point while the form is
 * open. A modal dialog would break the one interaction the screen
 * exists for. What Radix would have given us for free and we have to
 * supply here is Escape handling and a portal; what it would have
 * taken away is the whole point. The repo rule that sends new dialogs
 * to ui/dialog is aimed at hand-rolled `fixed inset-0` backdrops;
 * these sheets have no backdrop at all.
 *
 * What it does provide, none of which the hand-rolled sheets had:
 *
 *   - **Android hardware back closes the sheet.** It used to exit the
 *     app and discard whatever was in the form. That is the single
 *     worst thing in the audit's UI list, because it is data loss
 *     reachable by the most-pressed button on the device.
 *   - **Soft keyboard.** iOS leaves a `position: fixed` element at the
 *     layout viewport's bottom edge, which is BEHIND the keyboard, so
 *     a collector typing into the last field of a form could not see
 *     what they were typing. The sheet tracks visualViewport and
 *     lifts itself clear.
 *   - **dvh, not vh.** The two sheets a collector touches most were
 *     the two still sized in `vh`, which on iOS means "as if the URL
 *     bar were hidden" and cuts off the bottom of the sheet.
 *   - **Drag between snap points**, so a long attribute list can be
 *     pulled up without leaving the sheet, and a flick down dismisses.
 *   - **overscroll-behavior: contain**, so scrolling to the end of the
 *     sheet does not rubber-band the page behind it or trigger
 *     pull-to-refresh in an installed PWA.
 *   - Escape, and a pressed state on the drag handle.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Fraction of the visible viewport a snap point occupies. */
export type SnapPoint = number;

/** Distinguishes each mounted sheet's history entry from any other. */
let sheetSequence = 0;

/**
 * Height of the part of the screen not covered by the soft keyboard,
 * plus how far the sheet must lift to clear it.
 *
 * `visualViewport` is the only honest source for this. Its height
 * shrinks when the keyboard opens on both platforms; `window.innerHeight`
 * does not move on iOS, which is exactly why a fixed-bottom element
 * ends up underneath the keyboard there.
 */
function useViewportInsets(): { height: number; keyboardInset: number } {
  const [insets, setInsets] = useState({ height: 0, keyboardInset: 0 });

  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const read = () => {
      if (!vv) {
        setInsets({ height: window.innerHeight, keyboardInset: 0 });
        return;
      }
      // What is hidden below the visual viewport: the keyboard, plus
      // any browser chrome that overlays the bottom.
      const hidden = Math.max(
        0,
        window.innerHeight - (vv.height + vv.offsetTop),
      );
      setInsets({ height: vv.height, keyboardInset: hidden });
    };
    read();
    if (!vv) {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, []);

  return insets;
}

/**
 * A short tap of haptic feedback, where the platform has it.
 *
 * Android Chrome implements the Vibration API; iOS Safari does not and
 * this is a silent no-op there. Worth doing anyway: it costs nothing,
 * and half the fleet feeling a snap confirm is better than none of it.
 * Deliberately not called on every state change, only on the discrete
 * physical-feeling ones (a snap landing, a dismiss).
 */
export function tapFeedback(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* Permissions policy can refuse it; never worth an error. */
  }
}

export interface FieldSheetProps {
  open: boolean;
  /** Called for every dismissal: Escape, hardware back, drag-down, or
   *  a close control inside `children`. */
  onClose: () => void;
  /** Named for screen readers. These sheets carry no visible heading
   *  in every mode, so this is not always derivable from the content. */
  ariaLabel: string;
  /**
   * Heights the sheet snaps to, as fractions of the visible viewport,
   * ascending. Dragging below the smallest dismisses.
   */
  snapPoints?: SnapPoint[];
  /** Index into `snapPoints` to open at. */
  initialSnap?: number;
  /** Told when the user drags to a different snap point, so a caller
   *  that renders differently when expanded can follow along. */
  onSnapChange?: (index: number) => void;
  /**
   * Suppress drag-to-dismiss. Set while a form holds unsaved input:
   * an accidental downward flick should not be able to throw away a
   * filled-in form. Dragging between snap points still works.
   */
  dismissOnDrag?: boolean;
  /** Fires before a dismissal the user could regret, e.g. Escape or
   *  back with unsaved input. Return false to refuse the dismissal. */
  onBeforeClose?: () => boolean;
  /**
   * How many pixels of the viewport this sheet is covering, reported
   * whenever it changes and 0 once closed.
   *
   * The field runtime feeds this to MapLibre as bottom padding. Before
   * that, tapping a feature in the lower half of the map opened a
   * sheet directly over the feature you had just tapped: the map never
   * moved, so the thing you asked about was the thing you could no
   * longer see.
   */
  onCoveredHeightChange?: (px: number) => void;
  children: ReactNode;
}

export function FieldSheet({
  open,
  onClose,
  ariaLabel,
  snapPoints = [0.55, 0.92],
  initialSnap = 0,
  onSnapChange,
  dismissOnDrag = true,
  onBeforeClose,
  onCoveredHeightChange,
  children,
}: FieldSheetProps) {
  const { height: viewportHeight, keyboardInset } = useViewportInsets();
  const [snapIndex, setSnapIndex] = useState(initialSnap);
  // Live drag offset in px, 0 when not dragging. Kept in state because
  // it drives the transform; the sheet is one element so this is cheap.
  const [dragOffset, setDragOffset] = useState(0);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartTimeRef = useRef(0);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Callbacks live in refs so the history and key effects do not
  // re-run (and re-push history) every time the parent re-renders.
  const onCloseRef = useRef(onClose);
  const onBeforeCloseRef = useRef(onBeforeClose);
  onCloseRef.current = onClose;
  onBeforeCloseRef.current = onBeforeClose;

  const requestClose = useCallback(() => {
    if (onBeforeCloseRef.current && !onBeforeCloseRef.current()) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (open) setSnapIndex(initialSnap);
  }, [open, initialSnap]);

  // Android hardware back. Pushing an entry while the sheet is open
  // means the back gesture pops that entry instead of leaving the
  // page, and popstate is where we hear about it. Without this, back
  // exits the field runtime and takes an in-progress form with it.
  const pushedTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const token = ++sheetSequence;
    pushedTokenRef.current = token;
    try {
      window.history.pushState({ __ggSheet: token }, '');
    } catch {
      // Some embedded webviews refuse pushState. The sheet still
      // works; back just leaves the page as it did before.
      pushedTokenRef.current = null;
    }
    const onPop = () => {
      // Our entry is gone already; do not try to pop it again.
      pushedTokenRef.current = null;
      // Deliberately NOT routed through onBeforeClose. The user has
      // pressed a system button, and refusing it would leave them
      // pressing back with nothing happening, which reads as a frozen
      // app. Callers that need a confirmation own that decision in
      // onClose, where they can re-open.
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed some other way (a button, the parent's state). Drop the
      // entry we added, or the collector has to press back twice to
      // leave the page. Only when it is still the current entry: if
      // they navigated away with the sheet open, the top of the stack
      // belongs to the router now and popping it would yank them back
      // from the page they asked for.
      const token = pushedTokenRef.current;
      pushedTokenRef.current = null;
      if (token === null) return;
      const state = window.history.state as { __ggSheet?: number } | null;
      if (state && state.__ggSheet === token) window.history.back();
    };
  }, [open]);

  // Escape. Radix would have given us this one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, requestClose]);

  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartTimeRef.current = Date.now();
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    setDragOffset(e.clientY - dragStartYRef.current);
  }, []);

  const onHandlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      const delta = e.clientY - dragStartYRef.current;
      const elapsed = Math.max(1, Date.now() - dragStartTimeRef.current);
      // px/ms. A flick beats distance: the gesture people make to
      // dismiss is fast and short, not slow and long.
      const velocity = delta / elapsed;
      setDragOffset(0);

      const isFlickDown = velocity > 0.5;
      const isFlickUp = velocity < -0.5;
      const threshold = viewportHeight * 0.12;

      if (isFlickUp || delta < -threshold) {
        if (snapIndex < snapPoints.length - 1) {
          const next = snapIndex + 1;
          setSnapIndex(next);
          onSnapChange?.(next);
          tapFeedback();
        }
        return;
      }
      if (isFlickDown || delta > threshold) {
        if (snapIndex > 0) {
          const next = snapIndex - 1;
          setSnapIndex(next);
          onSnapChange?.(next);
          tapFeedback();
          return;
        }
        if (dismissOnDrag) {
          tapFeedback(12);
          requestClose();
        }
      }
    },
    [
      dismissOnDrag,
      onSnapChange,
      requestClose,
      snapIndex,
      snapPoints.length,
      viewportHeight,
    ],
  );

  // Report how much of the viewport the sheet is covering, so the map
  // can pad itself out from under it. Fires on open, on every snap
  // change, when the keyboard resizes the viewport, and with 0 on
  // close.
  const coveredHeight = open
    ? Math.round(
        (viewportHeight || 0) * (snapPoints[snapIndex] ?? snapPoints[0] ?? 0),
      )
    : 0;
  const onCoveredRef = useRef(onCoveredHeightChange);
  onCoveredRef.current = onCoveredHeightChange;
  useEffect(() => {
    onCoveredRef.current?.(coveredHeight);
    return () => {
      // Unmounting IS closing, and a map left padded for a sheet that
      // is gone stays permanently off-centre.
      onCoveredRef.current?.(0);
    };
  }, [coveredHeight]);

  if (!open) return null;

  const fraction = snapPoints[snapIndex] ?? snapPoints[0] ?? 0.55;
  // Sized off the VISIBLE viewport, so the keyboard shrinking the
  // screen shrinks the sheet instead of pushing its content off.
  // Falls back to dvh before the first measurement lands, which is
  // still right on both platforms; vh is the one that is wrong.
  const height = viewportHeight
    ? `${Math.round(viewportHeight * fraction)}px`
    : `${Math.round(fraction * 100)}dvh`;
  // Downward drag follows the finger; upward is resisted, so the sheet
  // does not detach from the bottom edge.
  const dragTranslate = dragOffset > 0 ? dragOffset : dragOffset / 4;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      ref={sheetRef}
      className="fixed inset-x-0 bottom-0 z-30 flex flex-col"
      style={{
        // Lift clear of the soft keyboard. Zero when it is closed.
        transform: `translateY(${-keyboardInset + dragTranslate}px)`,
        transition: draggingRef.current
          ? 'none'
          : 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <div
        className="flex w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay"
        style={{
          height,
          // The keyboard already took its space out of `height`, so
          // the safe-area inset only applies when it is closed.
          paddingBottom: keyboardInset
            ? 0
            : 'env(safe-area-inset-bottom)',
          transition: draggingRef.current
            ? 'none'
            : 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {/* Drag handle. Its own hit area is deliberately taller than
            the visible bar: a 4px target is not reachable with a
            thumb, let alone a gloved one. touch-none stops the
            browser claiming the gesture as a scroll. */}
        <div
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          className="flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
          aria-hidden="true"
        >
          <div className="h-1 w-9 rounded-full bg-border" />
        </div>
        {/* overscroll-contain stops a scroll that reaches the end of
            this list from rubber-banding the page behind it, or
            triggering pull-to-refresh in an installed PWA. */}
        <div className="flex min-h-0 flex-1 flex-col overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
}
