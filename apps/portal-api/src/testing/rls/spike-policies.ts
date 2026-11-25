// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only database setup for the row-level security trial: two login
// roles, the helper functions the policies call, and example policies
// on three representative tables. It is applied by the tests to a
// throwaway database. No migration creates any of it.

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

/**
 * Role names per suite. Fixed identifiers, never taken from input.
 * Each suite has its own pair so suites running side by side on one
 * server do not drop each other's roles.
 */
export const SPIKE_ROLES = {
  tests: { app: 'gg_tp_app', system: 'gg_tp_system' },
  bench: { app: 'gg_tpb_app', system: 'gg_tpb_system' },
} as const;

export type SpikeRoleSet = (typeof SPIKE_ROLES)[keyof typeof SPIKE_ROLES];

/** Every SQL identifier this file writes into a statement. */
const IDENTIFIER = /^[a-z_]{1,40}$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error('unexpected identifier');
  return name;
}

export interface SpikeLogins {
  appUrl: string;
  systemUrl: string;
}

function loginUrl(base: string, database: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Create (or reset) the two login roles with fresh throwaway
 * passwords. Needs a connection that may create roles with BYPASSRLS
 * (a superuser on a test server).
 *
 * The password goes in as a bound parameter: it is placed in a session
 * setting and read back inside the server, because CREATE ROLE itself
 * cannot take parameters.
 */
export async function createSpikeRoles(
  admin: Pool,
  baseUrl: string,
  database: string,
  roles: SpikeRoleSet,
): Promise<SpikeLogins> {
  const app = ident(roles.app);
  const system = ident(roles.system);
  const appPassword = randomBytes(18).toString('hex');
  const systemPassword = randomBytes(18).toString('hex');
  const client = await admin.connect();
  try {
    await client.query(`DROP ROLE IF EXISTS ${app}`);
    await client.query(`DROP ROLE IF EXISTS ${system}`);
    await client.query(`CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await client.query(`CREATE ROLE ${system} LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`);
    await setPassword(client, app, appPassword);
    await setPassword(client, system, systemPassword);
  } finally {
    client.release();
  }
  return {
    appUrl: loginUrl(baseUrl, database, app, appPassword),
    systemUrl: loginUrl(baseUrl, database, system, systemPassword),
  };
}

async function setPassword(client: PoolClient, role: string, password: string): Promise<void> {
  await client.query("SELECT set_config('gg_spike.pw', $1, false)", [password]);
  await client.query(
    `DO $$ BEGIN
       EXECUTE format('ALTER ROLE ${ident(role)} PASSWORD %L', current_setting('gg_spike.pw'));
     END $$`,
  );
  await client.query("SELECT set_config('gg_spike.pw', '', false)");
}

export async function dropSpikeRoles(admin: Pool, roles: SpikeRoleSet): Promise<void> {
  await admin.query(`DROP ROLE IF EXISTS ${ident(roles.app)}`);
  await admin.query(`DROP ROLE IF EXISTS ${ident(roles.system)}`);
}

/**
 * Helper functions, as the design states them. A missing or empty
 * setting gives NULL (org and user) or 'none' (ctx), which no policy
 * branch matches.
 */
export const HELPER_FUNCTIONS_SQL = `
CREATE OR REPLACE FUNCTION gg_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('gratis.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION gg_ctx() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('gratis.ctx', true), ''), 'none') $$;

CREATE OR REPLACE FUNCTION gg_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('gratis.user_id', true), '')::uuid $$;

-- Guest slot. Returns false until guest access is designed.
CREATE OR REPLACE FUNCTION gg_guest_can_read_item(item_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT false $$;

-- The item id inside an observation scope ('data_layer:<uuid>:<layer>'),
-- or NULL for any other shape. Never raises, so a policy that calls it
-- cannot turn a bad scope into an error that names a value.
CREATE OR REPLACE FUNCTION gg_scope_item_id(scope text) RETURNS uuid
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE
      WHEN substring(scope FROM 1 FOR 11) = 'data_layer:'
       AND substring(scope FROM 12 FOR 36) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN substring(scope FROM 12 FOR 36)::uuid
    END
  $$;
`;

/** Basic shape for a table with org_id: own org only, every command. */
export const ORG_TABLE_POLICY_SQL = `
ALTER TABLE import_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_job_own_org ON import_job
  USING (org_id = (SELECT gg_org_id()))
  WITH CHECK (org_id = (SELECT gg_org_id()));
`;

/**
 * item: read own org, live public items, or the guest slot. Write own
 * org. The public branch also needs some stamp (any ctx but 'none'),
 * so a connection nobody stamped sees no rows at all, public or not.
 */
export const ITEM_POLICY_SQL = `
ALTER TABLE item ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_read ON item FOR SELECT
  USING (
    org_id = (SELECT gg_org_id())
    OR ((SELECT gg_ctx()) <> 'none' AND access = 'public' AND deleted_at IS NULL)
    OR gg_guest_can_read_item(id)
  );
CREATE POLICY item_insert ON item FOR INSERT
  WITH CHECK (org_id = (SELECT gg_org_id()));
CREATE POLICY item_update ON item FOR UPDATE
  USING (org_id = (SELECT gg_org_id()))
  WITH CHECK (org_id = (SELECT gg_org_id()));
CREATE POLICY item_delete ON item FOR DELETE
  USING (org_id = (SELECT gg_org_id()));
`;

/**
 * observation, writes only: every read is allowed (reads keep their
 * indexes), but a row can only be written, changed or deleted in a
 * layer whose item belongs to the stamped org. No new column: the
 * item is found from the scope. The item lookup itself runs under the
 * item policy, so another org's private item is not found at all.
 */
export const OBSERVATION_WRITES_ONLY_SQL = `
ALTER TABLE observation ENABLE ROW LEVEL SECURITY;
CREATE POLICY observation_read_all ON observation FOR SELECT USING (true);
CREATE POLICY observation_insert_own ON observation FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM item i
    WHERE i.id = gg_scope_item_id(scope) AND i.org_id = (SELECT gg_org_id())
  ));
CREATE POLICY observation_update_own ON observation FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM item i
    WHERE i.id = gg_scope_item_id(scope) AND i.org_id = (SELECT gg_org_id())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM item i
    WHERE i.id = gg_scope_item_id(scope) AND i.org_id = (SELECT gg_org_id())
  ));
CREATE POLICY observation_delete_own ON observation FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM item i
    WHERE i.id = gg_scope_item_id(scope) AND i.org_id = (SELECT gg_org_id())
  ));
`;

/**
 * The alternative measured for imports: an org_id column filled by a
 * trigger from the layer's item, and a plain equality check. Applied
 * only by the measurement, never by the tests.
 */
export const OBSERVATION_COLUMN_VARIANT_SQL = `
ALTER TABLE observation ADD COLUMN IF NOT EXISTS org_id uuid;
CREATE OR REPLACE FUNCTION gg_observation_fill_org() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  SELECT i.org_id INTO NEW.org_id FROM item i WHERE i.id = gg_scope_item_id(NEW.scope);
  RETURN NEW;
END $$;
CREATE TRIGGER observation_fill_org BEFORE INSERT ON observation
  FOR EACH ROW EXECUTE FUNCTION gg_observation_fill_org();
ALTER TABLE observation ENABLE ROW LEVEL SECURITY;
CREATE POLICY observation_read_all ON observation FOR SELECT USING (true);
CREATE POLICY observation_insert_own ON observation FOR INSERT
  WITH CHECK (org_id = (SELECT gg_org_id()));
`;

/** Undo either observation variant. */
export const OBSERVATION_NO_POLICY_SQL = `
DROP POLICY IF EXISTS observation_read_all ON observation;
DROP POLICY IF EXISTS observation_insert_own ON observation;
DROP POLICY IF EXISTS observation_update_own ON observation;
DROP POLICY IF EXISTS observation_delete_own ON observation;
DROP TRIGGER IF EXISTS observation_fill_org ON observation;
ALTER TABLE observation DISABLE ROW LEVEL SECURITY;
`;

/** Grants both roles need on the tables the trial touches. */
export function grantsSql(roles: SpikeRoleSet): string {
  const both = `${ident(roles.app)}, ${ident(roles.system)}`;
  return `
GRANT USAGE ON SCHEMA public TO ${both};
GRANT SELECT, INSERT, UPDATE, DELETE ON import_job, item, observation TO ${both};
GRANT SELECT ON organization, "user", item_share TO ${both};
GRANT EXECUTE ON FUNCTION gg_org_id(), gg_ctx(), gg_user_id(),
  gg_guest_can_read_item(uuid), gg_scope_item_id(text) TO ${both};
`;
}

/** Functions, grants and the three example policies. Run as the owner. */
export async function applySpikePolicies(owner: Pool, roles: SpikeRoleSet): Promise<void> {
  await owner.query(HELPER_FUNCTIONS_SQL);
  await owner.query(grantsSql(roles));
  await owner.query(ORG_TABLE_POLICY_SQL);
  await owner.query(ITEM_POLICY_SQL);
  await owner.query(OBSERVATION_WRITES_ONLY_SQL);
}
