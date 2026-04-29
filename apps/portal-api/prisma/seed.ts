/**
 * Dev seed. Mirrors the Keycloak realm seed: org `acme` with three
 * generic users keyed on the role they exercise (admin, contributor,
 * viewer). Passwords match usernames so a fresh-install reviewer can
 * sign in without consulting docs.
 *
 * Replaces the older Mateo / Bob / Alice naming (#170): role-named
 * accounts are easier to remember and self-document what each session
 * is testing.
 *
 * Run: `pnpm --filter @gratis-gis/portal-api db:seed`
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACME_ID = '11111111-1111-1111-1111-111111111111';
// UUIDs preserved from the previous seed so existing dev databases
// stay aligned on foreign keys even though the human identifiers
// moved. CONTRIBUTOR_ID was Mateo (originally Alice); ADMIN_ID was
// Bob. VIEWER_ID is brand new in this seed.
const CONTRIBUTOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADMIN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VIEWER_ID = 'eeeeeeee-1111-eeee-1111-eeeeeeeeeeee';
const GROUP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function main() {
  console.log('-> seeding organization');
  const org = await prisma.organization.upsert({
    where: { id: ACME_ID },
    update: {},
    create: { id: ACME_ID, slug: 'acme', name: 'Acme Corp' },
  });

  console.log('-> seeding users');
  await prisma.user.upsert({
    where: { id: ADMIN_ID },
    update: {
      username: 'admin',
      email: 'admin@acme.test',
      fullName: 'Admin User',
      orgRole: 'admin',
    },
    create: {
      id: ADMIN_ID,
      orgId: org.id,
      username: 'admin',
      email: 'admin@acme.test',
      fullName: 'Admin User',
      orgRole: 'admin',
    },
  });
  await prisma.user.upsert({
    where: { id: CONTRIBUTOR_ID },
    update: {
      username: 'contributor',
      email: 'contributor@acme.test',
      fullName: 'Contributor User',
      orgRole: 'contributor',
    },
    create: {
      id: CONTRIBUTOR_ID,
      orgId: org.id,
      username: 'contributor',
      email: 'contributor@acme.test',
      fullName: 'Contributor User',
      orgRole: 'contributor',
    },
  });
  await prisma.user.upsert({
    where: { id: VIEWER_ID },
    update: {
      username: 'viewer',
      email: 'viewer@acme.test',
      fullName: 'Viewer User',
      orgRole: 'viewer',
    },
    create: {
      id: VIEWER_ID,
      orgId: org.id,
      username: 'viewer',
      email: 'viewer@acme.test',
      fullName: 'Viewer User',
      orgRole: 'viewer',
    },
  });

  console.log('-> seeding group');
  await prisma.group.upsert({
    where: { id: GROUP_ID },
    update: {},
    create: {
      id: GROUP_ID,
      orgId: org.id,
      title: 'Field Team',
      description: 'Members collecting field data for Acme.',
      access: 'org',
      ownerId: ADMIN_ID,
    },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: CONTRIBUTOR_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: CONTRIBUTOR_ID, role: 'member' },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: ADMIN_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: ADMIN_ID, role: 'admin' },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: VIEWER_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: VIEWER_ID, role: 'member' },
  });

  console.log('-> seeding items');

  // Small demo data_layer: a handful of points around the Acme HQ
  // neighborhood with a category attribute so unique-value and filter
  // UI have something to chew on.
  const demoBuildings = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [-122.4194, 37.7749] },
        properties: { name: 'Main Office', category: 'office', floors: 6 },
      },
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [-122.4202, 37.7755] },
        properties: { name: 'Engineering', category: 'office', floors: 4 },
      },
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [-122.4187, 37.7762] },
        properties: { name: 'Cafeteria', category: 'amenity', floors: 1 },
      },
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [-122.4215, 37.7744] },
        properties: { name: 'Warehouse', category: 'operations', floors: 2 },
      },
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [-122.4170, 37.7770] },
        properties: { name: 'Annex', category: 'office', floors: 3 },
      },
    ],
  };

  await prisma.item.upsert({
    where: { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
    update: {},
    create: {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      orgId: org.id,
      ownerId: CONTRIBUTOR_ID,
      type: 'data_layer',
      title: 'Acme Buildings',
      description: 'Demo data layer with the Acme campus buildings.',
      tags: ['campus', 'buildings', 'demo'],
      data: {
        version: 1,
        fields: [
          { name: 'name', type: 'string', label: 'Name', nullable: false },
          { name: 'category', type: 'string', label: 'Category', nullable: false },
          { name: 'floors', type: 'number', label: 'Floors', nullable: true },
        ],
        data: demoBuildings,
        updatedAt: new Date().toISOString(),
      },
      access: 'org',
    },
  });

  await prisma.item.upsert({
    where: { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' },
    update: {},
    create: {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      orgId: org.id,
      ownerId: CONTRIBUTOR_ID,
      type: 'map',
      title: 'Acme HQ Campus Map',
      description: 'Basemap + building outlines, shared to the Field Team.',
      tags: ['campus', 'buildings'],
      data: {
        version: 1,
        basemap: 'positron',
        center: [-122.4194, 37.7755],
        zoom: 16,
        bearing: 0,
        pitch: 0,
        layers: [],
      },
      access: 'private',
    },
  });

  console.log('seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
