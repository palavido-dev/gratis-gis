// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Load the curated "Randolph County" sample workspace into the demo
// org by calling the same endpoint the portal's own "Load sample
// data" button calls: POST /api/items/sample-data.
//
// Why a script and not just clicking the button: the button acts as
// the signed-in user, so the seventeen items it creates end up owned
// by whoever clicked. The golden snapshot's invariant is that every
// item belongs to the bootstrap admin (see cleanup-non-admin.mjs),
// so seeding has to be reproducible from the host and followed by an
// ownership fix-up. infra/seed-demo-workspace.sh does both in order.
//
// Runs inside the portal-api container, for the same reasons
// cleanup-non-admin.mjs does: it needs the compose network to reach
// `keycloak` and `localhost:4000`, and it inherits the container's
// Keycloak service-account credentials so nothing secret crosses the
// host command line.
//
// Idempotent. SamplesService dedupes on `seedKind` across the whole
// org, including trashed rows, so a second run reports every slug as
// skipped rather than planting a second workspace.
//
// Required env (present in the portal-api container environment):
//   KEYCLOAK_ADMIN_CLIENT_ID      - default 'portal-api-admin'
//   KEYCLOAK_ADMIN_CLIENT_SECRET  - the service-account secret
// Optional env:
//   API_URL                - default 'http://localhost:4000'
//   KEYCLOAK_INTERNAL_URL  - default 'http://keycloak:8080'; the
//                            public hostname blocks /admin/* at Caddy
//   KEYCLOAK_REALM         - default 'gratis-gis'
//
// Exit code: 0 when the endpoint reports success (created and/or
// skipped), 1 on any auth or response failure. Fails closed so a
// caller can trust that a 0 means the sample set is present.

const API = process.env.API_URL ?? 'http://localhost:4000';
const KEYCLOAK = process.env.KEYCLOAK_INTERNAL_URL ?? 'http://keycloak:8080';
const REALM = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
const CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'portal-api-admin';
const CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;

if (!CLIENT_SECRET) {
  console.error(
    'seed-sample-content: KEYCLOAK_ADMIN_CLIENT_SECRET is required (it is part of the portal-api container environment; run this script via docker exec into that container).',
  );
  process.exit(1);
}

async function getServiceToken() {
  const r = await fetch(
    `${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    },
  );
  if (!r.ok) {
    throw new Error(`keycloak ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.access_token) {
    throw new Error(`no access_token: ${JSON.stringify(j).slice(0, 200)}`);
  }
  // Same fail-fast diagnosis as cleanup-non-admin.mjs: portal-api's
  // JWT strategy hard-requires the org claim, and seeding needs
  // can_publish_items, which org_role=admin carries. Missing claims
  // mean deploy.sh's Keycloak reconciliation hasn't run on this realm.
  // base64url, not base64: JWT segments use the URL-safe alphabet.
  // Node's 'base64' decoder happens to tolerate it, but relying on
  // that is the kind of thing that breaks silently on a runtime bump.
  const payload = JSON.parse(
    Buffer.from(j.access_token.split('.')[1], 'base64url').toString(),
  );
  if (!payload.org || payload.org_role !== 'admin') {
    throw new Error(
      `service-account token is missing org/org_role=admin claims (org=${payload.org ?? 'unset'}, org_role=${payload.org_role ?? 'unset'}); run infra/deploy.sh once so its Keycloak reconciliation grants portal-api-admin a portal-admin identity, then retry`,
    );
  }
  return j.access_token;
}

(async () => {
  const token = await getServiceToken();
  console.log(
    `seed-sample-content: authenticated as ${CLIENT_ID} service account`,
  );

  // No timeout override on purpose: the seeder writes seventeen
  // items, several of which create backing feature tables, so the
  // call is measured in seconds rather than milliseconds. The
  // service serialises concurrent calls per org internally.
  const r = await fetch(`${API}/api/items/sample-data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await r.text();
  if (!r.ok) {
    throw new Error(`POST /api/items/sample-data -> ${r.status}: ${body.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`unparseable response: ${body.slice(0, 200)}`);
  }
  const created = Array.isArray(parsed.created) ? parsed.created : [];
  const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
  // A run where nothing was created and nothing was skipped means the
  // endpoint answered but seeded no workspace at all. Treat that as a
  // failure rather than reporting a cheerful no-op.
  if (created.length === 0 && skipped.length === 0) {
    throw new Error(
      `endpoint reported neither created nor skipped slugs: ${body.slice(0, 200)}`,
    );
  }
  for (const slug of created) console.log(`  + ${slug}`);
  for (const slug of skipped) console.log(`  = ${slug} (already present)`);
  console.log(
    `seed-sample-content: done. created=${created.length} skipped=${skipped.length}`,
  );
})().catch((e) => {
  console.error(
    'seed-sample-content FATAL:',
    e instanceof Error ? e.message : e,
  );
  process.exit(1);
});
