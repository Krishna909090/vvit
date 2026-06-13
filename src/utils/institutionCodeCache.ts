import prisma from '../config/prisma';

// In-memory cache: code → id. Only 3-4 entries; populated on first use per code.
const cache = new Map<string, string>();

export async function resolveInstitutionCodeId(code: string | null | undefined): Promise<string | null> {
    if (!code) return null;
    const cached = cache.get(code);
    if (cached) return cached;
    const rec = await prisma.institutionCode.findUnique({ where: { code }, select: { id: true } });
    if (rec) cache.set(code, rec.id);
    return rec?.id ?? null;
}
