import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { afterAll } from 'vitest';

const runDatabaseTests = process.env.RUN_DB_TESTS === 'true';
const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!runDatabaseTests)('MySQL schema', () => {
  it('contains the organizations table and required columns', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ Field: string }>
    >`SHOW COLUMNS FROM organizations`;
    const names = columns.map((column) => column.Field);

    expect(names).toEqual(
      expect.arrayContaining(['id', 'name', 'slug', 'status', 'created_at', 'updated_at']),
    );
  });

  it('enforces unique slugs and accepts supported statuses', async () => {
    const firstSlug = `phase-one-${Date.now()}`;
    const first = await prisma.organization.create({
      data: { name: 'Phase One Organization', slug: firstSlug, status: 'ACTIVE' },
    });

    await expect(
      prisma.organization.create({
        data: { name: 'Duplicate Organization', slug: firstSlug, status: 'SUSPENDED' },
      }),
    ).rejects.toThrow();

    const suspended = await prisma.organization.create({
      data: { name: 'Suspended Organization', slug: `${firstSlug}-suspended`, status: 'SUSPENDED' },
    });

    expect(first.status).toBe('ACTIVE');
    expect(suspended.status).toBe('SUSPENDED');

    await expect(
      prisma.organization.create({
        data: { name: 'Invalid Organization', slug: `${firstSlug}-invalid`, status: 'INVALID' },
      }),
    ).rejects.toThrow();

    await prisma.organization.deleteMany({ where: { id: { in: [first.id, suspended.id] } } });
  });

  it('supports CRUD, pagination, filtering, sorting, and concurrent slug protection', async () => {
    const prefix = `live-${Date.now()}`;
    const first = await prisma.organization.create({
      data: { name: `${prefix} Alpha`, slug: `${prefix}-alpha` },
    });
    const second = await prisma.organization.create({
      data: { name: `${prefix} Bravo`, slug: `${prefix}-bravo` },
    });

    const listed = await prisma.organization.findMany({
      where: { name: { contains: prefix } },
      orderBy: { name: 'asc' },
      skip: 0,
      take: 1,
    });
    const total = await prisma.organization.count({ where: { name: { contains: prefix } } });
    const updated = await prisma.organization.update({
      where: { id: first.id },
      data: { name: `${prefix} Updated`, status: 'SUSPENDED' },
    });
    const concurrentSlug = `${prefix}-concurrent`;
    const results = await Promise.allSettled([
      prisma.organization.create({ data: { name: 'Concurrent A', slug: concurrentSlug } }),
      prisma.organization.create({ data: { name: 'Concurrent B', slug: concurrentSlug } }),
    ]);

    expect(listed).toHaveLength(1);
    expect(total).toBe(2);
    expect(updated.status).toBe('SUSPENDED');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    await prisma.organization.deleteMany({
      where: { id: { in: [first.id, second.id] } },
    });
    await prisma.organization.deleteMany({ where: { slug: concurrentSlug } });
  });
});
