// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-snapshot purge: delete every item whose owner is NOT the
// bootstrap admin so a stray tester user's work doesn't get baked
// into the daily golden-state snapshot.
//
// Runs inside the portal-api container during snapshot-golden.sh
// (so it can reach `keycloak` and `localhost:4000` over the compose
// network, and inherits the container's Keycloak service-account
// credentials).
//
// Auth model: a client_credentials token from the portal-api-admin
// service account. Every interactive realm client ships with
// directAccessGrantsEnabled=false, so the old password grant as the
// bootstrap admin can never succeed on a fresh install; the
// confidential service account is the one credential that can mint
// a token non-interactively. deploy.sh's Keycloak reconciliation
// grants that service account a portal-admin identity (org /
// org_role protocol mappers on the client, org + org_role=admin
// attributes on the service-account user); without it portal-api
// rejects the token and this script fails closed with a pointer to
// re-run deploy.sh.
//
// "The admin" whose items survive is identified by USERNAME, not by
// token subject: the token's sub is the service account, and local
// user ids can legitimately differ from Keycloak subs for seeded
// accounts (auth-sync upserts by username and never rewrites ids).
// Username is the stable join key on both sides, which is the same
// doctrine portal-api's own admin-users controller follows.
//
// For each non-admin item: soft-delete then purge via the portal-api
// REST endpoints. That routes through ItemsService.purge ->
// tearDownItemBackingStorage, which drops per-layer feature tables,
// removes MinIO blobs, and tidies observation partitions. SQL-only
// deletion would leave those as orphans, which then end up in the
// MinIO tarball and bloat the snapshot.
//
// Required env (present in the portal-api container environment):
//   KEYCLOAK_ADMIN_CLIENT_ID      - default 'portal-api-admin'
//   KEYCLOAK_ADMIN_CLIENT_SECRET  - the service-account secret
// Optional env:
//   ADMIN_USERNAME         - default 'admin'; the bootstrap admin
//                            whose items make up the demo content
//   API_URL                - default 'http://localhost:4000'
//   KEYCLOAK_INTERNAL_URL  - default 'http://keycloak:8080'; must be
//                            the in-network base because the public
//                            hostname blocks /admin/* at Caddy
//   KEYCLOAK_REALM         - default 'gratis-gis'
//
// Exit code: 0 on full or partial purge success (logs are the source
// of truth; a single stuck item shouldn't block the snapshot). 1 on
// any auth, listing, or response-shape failure: if we can't reliably
// tell what to keep, failing closed protects against both wiping the
// demo content and silently snapshotting a polluted DB.

const API = process.env.API_URL ?? 'http://localhost:4000';
// KEYCLOAK_URL in this container is the PUBLIC hostname; the admin
// REST surface is blocked at Caddy there, so the internal docker
// network address is the one that works for every call we make.
const KEYCLOAK = process.env.KEYCLOAK_INTERNAL_URL ?? 'http://keycloak:8080';
const REALM = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
const CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'portal-api-admin';
const CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';

if (!CLIENT_SECRET) {
  console.error(
    'cleanup-non-admin: KEYCLOAK_ADMIN_CLIENT_SECRET is required (it is part of the portal-api container environment; run this script via docker exec into that container).',
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
  // Fail fast, with a diagnosis, if the token can't possibly pass
  // portal-api's auth: the JWT strategy hard-requires the org claim
  // and the admin endpoints require org_role=admin. Missing claims
  // mean the deploy.sh Keycloak reconciliation (which installs the
  // org / org_role mappers on this client and the attributes on its
  // service-account user) has not run against this realm yet.
  const payload = JSON.parse(
    Buffer.from(j.access_token.split('.')[1], 'base64').toString(),
  );
  if (!payload.org || payload.org_role !== 'admin') {
    throw new Error(
      `service-account token is missing org/org_role=admin claims (org=${payload.org ?? 'unset'}, org_role=${payload.org_role ?? 'unset'}); run infra/deploy.sh once so its Keycloak reconciliation grants portal-api-admin a portal-admin identity, then retry`,
    );
  }
  return j.access_token;
}

/**
 * Walk the items list and the admin trash list, dedupe by id, and
 * return every item the service account can see (as an org admin,
 * that is every item in the org). The two endpoints partition by
 * deleted_at (live vs trashed) and don't overlap on a healthy
 * deployment, but dedupe is cheap defense if a future portal-api
 * version changes the contract.
 *
 * Fail-closed rules: any auth error (401/403) or a failure of the
 * live list aborts the run, because an incomplete listing would
 * either purge nothing (baking tester garbage into the golden
 * state) or purge the wrong things. Only a 404 on /trash is
 * tolerated, for older portal-api versions without that endpoint.
 */
async function listAllItems(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const byId = new Map();
  async function pull(path, { tolerate404 = false } = {}) {
    const r = await fetch(`${API}${path}`, { headers });
    if (r.status === 404 && tolerate404) {
      console.log(`list ${path} -> 404 (endpoint absent; skipping)`);
      return;
    }
    if (!r.ok) {
      throw new Error(
        `list ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
    }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.items ?? j.data ?? []);
    for (const it of arr) {
      // Shape guard: the keep/purge decision keys on owner.username.
      // If the API ever stops serializing the owner projection, every
      // item would look non-admin and the purge would wipe the demo
      // content, so a missing owner is a hard abort, not a skip.
      if (typeof it?.owner?.username !== 'string') {
        throw new Error(
          `item ${it?.id ?? '(no id)'} from ${path} has no owner.username; response shape changed, refusing to guess what to purge`,
        );
      }
      byId.set(it.id, it);
    }
  }
  // limit=1000 is the API's hard page cap (pageSize was never a real
  // parameter). The demo org sits far below it; if it ever grows past
  // the cap, unfetched items are simply left alone, which fails in
  // the safe direction for a purge (leftover content, never a wrong
  // delete). Note the live list also pages by default now; keep this
  // in mind before reusing the script against a large org.
  await pull('/api/items?limit=1000');
  await pull('/api/items/trash', { tolerate404: true });
  return [...byId.values()];
}

async function purgeOne(token, item) {
  const headers = { Authorization: `Bearer ${token}` };
  // Live items must be trashed before they can be purged
  // (ItemsService.purge gates on item.deletedAt). Trashed items
  // skip straight to purge.
  if (!item.deletedAt) {
    const r = await fetch(`${API}/api/items/${item.id}`, {
      method: 'DELETE',
      headers,
    });
    if (!r.ok) {
      console.error(
        `  soft-delete ${item.id} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
      return false;
    }
  }
  const r = await fetch(`${API}/api/items/${item.id}/purge`, {
    method: 'DELETE',
    headers,
  });
  if (!r.ok) {
    console.error(
      `  purge ${item.id} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
    );
    return false;
  }
  return true;
}

(async () => {
  const token = await getServiceToken();
  console.log(
    `cleanup-non-admin: authenticated as ${CLIENT_ID} service account; keeping items owned by '${ADMIN_USERNAME}'`,
  );

  const items = await listAllItems(token);
  // Keep the bootstrap admin's items. Anything the service account
  // itself might own (it creates nothing today, but belt and
  // suspenders) is also kept so the tooling can never eat its own
  // account's rows.
  const saUsername = `service-account-${CLIENT_ID}`;
  const toPurge = items.filter(
    (i) =>
      i.owner.username !== ADMIN_USERNAME && i.owner.username !== saUsername,
  );
  console.log(
    `cleanup-non-admin: ${items.length} items total, ${toPurge.length} non-admin to purge`,
  );

  let ok = 0;
  let fail = 0;
  for (const it of toPurge) {
    const success = await purgeOne(token, it);
    if (success) {
      console.log(
        `  ok ${it.type}\t${it.title} (${it.id}${it.deletedAt ? ', was trashed' : ''}, owner=${it.owner.username})`,
      );
      ok += 1;
    } else {
      fail += 1;
    }
  }
  console.log(`cleanup-non-admin: done. purged=${ok} failed=${fail}`);
  // Exit 0 even with partial failures. The snapshot proceeds; the
  // failed ids get another chance on the next run, and the operator
  // sees them in the snapshot log.
})().catch((e) => {
  console.error('cleanup-non-admin FATAL:', e instanceof Error ? e.message : e);
  // Reached on token, listing, or shape failures (thrown above).
  // Per-item purge failures are logged + swallowed in purgeOne so
  // one bad item doesn't block the snapshot; everything that
  // undermines the keep/purge decision itself fails the run.
  process.exit(1);
});
