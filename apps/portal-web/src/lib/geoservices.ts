// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The FeatureServer URL of a data layer item, as ArcGIS Pro and QGIS
 * open it. The service name is the title made safe for a URL, then the
 * item id: the same rule as serviceName in the API
 * (apps/portal-api/src/featureserver/featureserver-access.service.ts).
 * Only the id decides which item opens, so a title that changes later
 * does not break a saved project.
 */
export function geoservicesServiceName(itemId: string, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? `${slug}_${itemId}` : itemId;
}

export function featureServerUrl(origin: string, itemId: string, title: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/api/geoservices/rest/services/${geoservicesServiceName(itemId, title)}/FeatureServer`;
}
