/**
 * Dev seed. Mirrors the Keycloak realm seed: org `acme` with Mateo (contributor)
 * and Bob (admin), plus a group and a couple of example items.
 *
 * Run: `pnpm --filter @gratis-gis/portal-api db:seed`
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACME_ID = '11111111-1111-1111-1111-111111111111';
// UUID preserved from the previous "Alice" seed so existing dev databases
// stay aligned on foreign keys even though the human identifiers moved.
const MATEO_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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
    where: { id: MATEO_ID },
    update: {
      username: 'mateo',
      email: 'mateo@acme.test',
      fullName: 'Mateo García',
    },
    create: {
      id: MATEO_ID,
      orgId: org.id,
      username: 'mateo',
      email: 'mateo@acme.test',
      fullName: 'Mateo García',
      orgRole: 'contributor',
    },
  });
  await prisma.user.upsert({
    where: { id: BOB_ID },
    update: {},
    create: {
      id: BOB_ID,
      orgId: org.id,
      username: 'bob',
      email: 'bob@acme.test',
      fullName: 'Bob Example',
      orgRole: 'admin',
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
      ownerId: BOB_ID,
    },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: MATEO_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: MATEO_ID, role: 'member' },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: BOB_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: BOB_ID, role: 'admin' },
  });

  console.log('-> seeding items');

  // Small demo feature service: a handful of points around the Acme HQ
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
      ownerId: MATEO_ID,
      type: 'data_layer',
      title: 'Acme Buildings',
      description: 'Demo feature service with the Acme campus buildings.',
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
      ownerId: MATEO_ID,
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

  console.log('✓ seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$dis