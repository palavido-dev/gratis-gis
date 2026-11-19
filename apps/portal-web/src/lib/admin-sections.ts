// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every admin page, grouped by what an admin is trying to do. One
 * list drives the admin home's cards, its search and the breadcrumb
 * on each admin page, so a new page is added here once.
 *
 * `operatorOnly` marks a page whose whole API is limited to admins of
 * the operator organization (OperatorOrgGuard on the controller).
 * Those cards are hidden from other admins, who would only get a
 * refusal. A page where only some actions are operator-only (email
 * delivery, cleanup, the ArcGIS Online tools) stays visible to all.
 */

export type AdminGroupId = 'people' | 'portal' | 'data' | 'system';

export interface AdminSection {
  id: string;
  href: string;
  group: AdminGroupId;
  operatorOnly?: boolean;
  /** Extra words to match in search, in English, beyond the title and description. */
  keywords: string;
}

export const ADMIN_GROUPS: readonly AdminGroupId[] = ['people', 'portal', 'data', 'system'];

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { id: 'users', href: '/admin/users', group: 'people', keywords: 'invite role password disable account member people' },
  { id: 'sharing', href: '/admin/permissions', group: 'people', keywords: 'permissions access share public organization orphaned' },
  { id: 'audit', href: '/admin/audit', group: 'people', keywords: 'history log events changes who' },
  { id: 'signIn', href: '/admin/security', group: 'people', operatorOnly: true, keywords: 'security sso identity provider authenticator mfa 2fa login' },
  { id: 'landing', href: '/admin/branding', group: 'portal', keywords: 'branding logo colors home front page theme' },
  { id: 'ai', href: '/admin/ai', group: 'portal', keywords: 'llm openai claude ollama provider key model' },
  { id: 'feedback', href: '/admin/feedback', group: 'portal', operatorOnly: true, keywords: 'messages reports bugs suggestions' },
  { id: 'jobs', href: '/admin/jobs', group: 'data', keywords: 'import analysis queue cancel retry stuck' },
  { id: 'fieldQueues', href: '/admin/field-queues', group: 'data', keywords: 'offline sync devices mobile stuck' },
  { id: 'cleanup', href: '/admin/housekeeping', group: 'data', keywords: 'housekeeping stale unused orphaned storage retire' },
  { id: 'agoImport', href: '/admin/migrations', group: 'data', keywords: 'arcgis ago esri migration import export move' },
  { id: 'health', href: '/admin/operations', group: 'system', operatorOnly: true, keywords: 'operations readiness status maintenance services' },
  { id: 'backup', href: '/admin/backup', group: 'system', operatorOnly: true, keywords: 'restore snapshot export disaster' },
  { id: 'updates', href: '/admin/updates', group: 'system', keywords: 'upgrade release version new' },
  { id: 'email', href: '/admin/notifications', group: 'system', keywords: 'notifications smtp mail stuck templates' },
  { id: 'support', href: '/admin/diagnostics', group: 'system', keywords: 'diagnostics help bundle debug versions' },
];

/** The sections this admin can use: all of them for an operator, fewer otherwise. */
export function visibleSections(operator: boolean): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => operator || !s.operatorOnly);
}

/**
 * Sections whose title, description or keywords hold every word of
 * the query, case-insensitively. An empty query matches everything.
 */
export function searchSections(
  sections: readonly AdminSection[],
  query: string,
  text: (s: AdminSection) => string,
): AdminSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...sections];
  return sections.filter((s) => {
    const hay = `${text(s)} ${s.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The section an admin path belongs to, for the breadcrumb. */
export function sectionForPath(pathname: string): AdminSection | null {
  return (
    ADMIN_SECTIONS.find(
      (s) => pathname === s.href || pathname.startsWith(`${s.href}/`),
    ) ?? null
  );
}
