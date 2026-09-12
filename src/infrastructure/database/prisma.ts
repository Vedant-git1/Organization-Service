import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function checkDatabaseHealth(
  client: Pick<PrismaClient, '$queryRaw'> = prisma,
): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
