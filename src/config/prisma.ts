
import { PrismaClient, Prisma } from '@prisma/client';
import { getContext } from '../utils/requestContext';

const url = process.env.DATABASE_URL || '';
const host = url.split('@')[1]?.split('/')[0] || 'Unknown';
console.log(`[Prisma Init] Connecting to Host: ${host}`);

const prismaClient = new PrismaClient();

// Identify models with Soft Delete (isDeleted column)
const modelsWithSoftDelete = new Set<string>();
const dmmf = Prisma.dmmf;
if (dmmf && dmmf.datamodel) {
    dmmf.datamodel.models.forEach(model => {
        const hasIsDeleted = model.fields.some(f => f.name === 'isDeleted');
        if (hasIsDeleted) {
            modelsWithSoftDelete.add(model.name);
        }
    });
}

// Extended Client to enforce Audit Rules
const prisma = prismaClient.$extends({
    query: {
        $allModels: {
            async create({ model, args, query }) {
                const { userId } = getContext();
                args.data = {
                    ...args.data,
                    createdAt: new Date(),
                    createdBy: userId,
                    updatedAt: new Date(),
                    updatedBy: userId
                };
                return query(args);
            },
            async createMany({ model, args, query }) {
                const { userId } = getContext();
                if (Array.isArray(args.data)) {
                    args.data = args.data.map(item => ({
                        ...item,
                        createdAt: new Date(),
                        createdBy: userId,
                        updatedAt: new Date(),
                        updatedBy: userId
                    }));
                } else {
                    args.data = {
                        ...args.data,
                        createdAt: new Date(),
                        createdBy: userId,
                        updatedAt: new Date(),
                        updatedBy: userId
                    };
                }
                return query(args);
            },
            async update({ model, args, query }) {
                const { userId } = getContext();
                args.data = {
                    ...args.data,
                    updatedAt: new Date(),
                    updatedBy: userId
                };
                
                // Prevent modification of creation fields
                if ((args.data as any).createdAt) delete (args.data as any).createdAt;
                if ((args.data as any).createdBy) delete (args.data as any).createdBy;
                
                return query(args);
            },
            async updateMany({ model, args, query }) {
                const { userId } = getContext();
                args.data = {
                    ...args.data,
                    updatedAt: new Date(),
                    updatedBy: userId
                };
                 // Prevent modification of creation fields
                if ((args.data as any).createdAt) delete (args.data as any).createdAt;
                if ((args.data as any).createdBy) delete (args.data as any).createdBy;
                
                return query(args);
            },
            async upsert({ model, args, query }) {
                const { userId } = getContext();
                
                // Create part
                args.create = {
                    ...args.create,
                    createdAt: new Date(),
                    createdBy: userId,
                    updatedAt: new Date(),
                    updatedBy: userId
                };

                // Update part
                args.update = {
                    ...args.update,
                    updatedAt: new Date(),
                    updatedBy: userId
                };
                
                if ((args.update as any).createdAt) delete (args.update as any).createdAt;
                if ((args.update as any).createdBy) delete (args.update as any).createdBy;

                return query(args);
            },
            async delete({ model, args, query }) {
                if (modelsWithSoftDelete.has(model)) {
                    const { userId } = getContext();
                    // Perform soft delete (update) using raw client to avoid circular hooks if we were calling the extended one
                    // We must cast keys to allow dynamic access
                    return (prismaClient as any)[model].update({
                        where: args.where,
                        data: {
                            isDeleted: true,
                            updatedAt: new Date(),
                            updatedBy: userId
                        }
                    });
                }
                return query(args);
            },
            async deleteMany({ model, args, query }) {
                if (modelsWithSoftDelete.has(model)) {
                    const { userId } = getContext();
                    return (prismaClient as any)[model].updateMany({
                        where: args.where,
                        data: {
                            isDeleted: true,
                            updatedAt: new Date(),
                            updatedBy: userId
                        }
                    });
                }
                return query(args);
            }
        }
    }
});

export default prisma;
