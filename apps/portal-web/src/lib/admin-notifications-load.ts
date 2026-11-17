// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How the admin Notifications page reads its five requests. Stats,
 * recent activity and SMTP are install-wide and answer 403 to admins
 * of any organization but the operator; defaults and templates are
 * per organization. A 403 on the operator calls hides those sections
 * and nothing else, so a non-operator admin still gets their own
 * organization's templates. Any other failure is an error.
 */
export interface NotificationsAdminLoad<S, R, M, D, T> {
  operator: boolean;
  stats: S | null;
  recent: R[];
  smtp: M | null;
  defaults: D[] | null;
  templateOverrides: T[] | null;
  /** The first failure that is not an operator 403, if any. */
  error: unknown;
}

function isForbidden(x: PromiseSettledResult<unknown>): boolean {
  return (
    x.status === 'rejected' &&
    (x.reason as { status?: number } | null)?.status === 403
  );
}

export async function loadNotificationsAdmin<S, R, M, D, T>(calls: {
  stats: () => Promise<S>;
  recent: () => Promise<R[]>;
  smtp: () => Promise<M>;
  defaults: () => Promise<{ rows: D[] }>;
  templates: () => Promise<{ rows: T[] }>;
}): Promise<NotificationsAdminLoad<S, R, M, D, T>> {
  const [s, r, sm, df, tpl] = await Promise.allSettled([
    calls.stats(),
    calls.recent(),
    calls.smtp(),
    calls.defaults(),
    calls.templates(),
  ]);
  const operator = !isForbidden(s) && !isForbidden(r) && !isForbidden(sm);
  // Only the operator calls may answer 403 quietly. A 403 on defaults
  // or templates is a real failure.
  const failed = [
    ...[s, r, sm].filter((x) => !isForbidden(x)),
    df,
    tpl,
  ].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
  return {
    operator,
    stats: operator && s.status === 'fulfilled' ? s.value : null,
    recent: operator && r.status === 'fulfilled' ? r.value : [],
    smtp: operator && sm.status === 'fulfilled' ? sm.value : null,
    defaults: df.status === 'fulfilled' ? df.value.rows : null,
    templateOverrides: tpl.status === 'fulfilled' ? tpl.value.rows : null,
    error: failed?.reason ?? null,
  };
}
