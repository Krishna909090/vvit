
import { PrismaClient, Prisma } from '@prisma/client';
import { getContext } from '../utils/requestContext';

const url = process.env.DATABASE_URL || '';
const host = url.split('@')[1]?.split('/')[0] || 'Unknown';
console.log(`[Prisma Init] Connecting to Host: ${host}`);

const prismaClient = new PrismaClient();

// Identify models with specific fields
const modelsWithSoftDelete = new Set<string>();
const modelsWithCreatedBy = new Set<string>();
const modelsWithUpdatedBy = new Set<string>();

const dmmf = Prisma.dmmf;
if (dmmf && dmmf.datamodel) {
    dmmf.datamodel.models.forEach(model => {
        const fields = model.fields.map(f => f.name);
        
        if (fields.includes('isDeleted')) {
            modelsWithSoftDelete.add(model.name);
        }
        if (fields.includes('createdBy')) {
            modelsWithCreatedBy.add(model.name);
        }
        if (fields.includes('updatedBy')) {
            modelsWithUpdatedBy.add(model.name);
        }
    });
}

// Extended Client to enforce Audit Rules
const prisma = prismaClient.$extends({
    query: {
        $allModels: {
            async create({ model, args, query }) {
                const { userId } = getContext();
                
                // Initialize args.data if undefined (rare but possible)
                args.data = args.data || {};

                // Always add timestamps if they exist (usually handled by @default(now()) or @updatedAt in schema, but we overwrite here?)
                // The original code was overwriting. We should continue that pattern if desired, or let schema handle timestamps.
                // However, schema @default(now()) implies DB handles it. Code sending explicit value overrides it.
                // Original code sent new Date().
                // Let's safe-guard timestamps too? No, usually OK to send unless explicitly excluded.
                // But let's focus on createdBy/updatedBy which cause error.

                const data: any = { ...args.data };
                
                data.createdAt = new Date();
                data.updatedAt = new Date();

                if (modelsWithCreatedBy.has(model)) {
                    data.createdBy = userId;
                }
                if (modelsWithUpdatedBy.has(model)) {
                    data.updatedBy = userId;
                }

                args.data = data;
                return query(args);
            },
            async createMany({ model, args, query }) {
                const { userId } = getContext();
                
                const enhanceItem = (item: any) => {
                    const enhanced: any = { 
                        ...item,
                        createdAt: new Date(),
                        updatedAt: new Date()
                    };
                    
                     if (modelsWithCreatedBy.has(model)) {
                        enhanced.createdBy = userId;
                    }
                    if (modelsWithUpdatedBy.has(model)) {
                        enhanced.updatedBy = userId;
                    }
                    return enhanced;
                };

                if (Array.isArray(args.data)) {
                    args.data = args.data.map(enhanceItem);
                } else {
                    args.data = enhanceItem(args.data);
                }
                
                return query(args);
            },
            async update({ model, args, query }) {
                const { userId } = getContext();
                
                args.data = args.data || {};
                const data: any = { ...args.data };

                data.updatedAt = new Date();

                if (modelsWithUpdatedBy.has(model)) {
                    data.updatedBy = userId;
                }
                
                // Prevent modification of creation fields if they exist in payload
                if (data.createdAt) delete data.createdAt;
                if (data.createdBy) delete data.createdBy;
                
                args.data = data;
                return query(args);
            },
            async updateMany({ model, args, query }) {
                const { userId } = getContext();
                
                args.data = args.data || {};
                const data: any = { ...args.data };

                data.updatedAt = new Date();
                
                if (modelsWithUpdatedBy.has(model)) {
                    data.updatedBy = userId;
                }

                 // Prevent modification of creation fields
                if (data.createdAt) delete data.createdAt;
                if (data.createdBy) delete data.createdBy;
                
                args.data = data;
                return query(args);
            },
            async upsert({ model, args, query }) {
                const { userId } = getContext();
                
                // Create part
                args.create = args.create || {};
                const createData: any = { ...args.create };
                createData.createdAt = new Date();
                createData.updatedAt = new Date();

                if (modelsWithCreatedBy.has(model)) {
                    createData.createdBy = userId;
                }
                if (modelsWithUpdatedBy.has(model)) {
                    createData.updatedBy = userId;
                }
                args.create = createData;

                // Update part
                args.update = args.update || {};
                const updateData: any = { ...args.update };
                updateData.updatedAt = new Date();

                if (modelsWithUpdatedBy.has(model)) {
                    updateData.updatedBy = userId;
                }
                
                if (updateData.createdAt) delete updateData.createdAt;
                if (updateData.createdBy) delete updateData.createdBy;
                
                args.update = updateData;

                return query(args);
            },
            async delete({ model, args, query }) {
                if (modelsWithSoftDelete.has(model)) {
                    const { userId } = getContext();
                    // Perform soft delete (update) using raw client to avoid circular hooks
                    
                    const updateData: any = {
                        isDeleted: true,
                        updatedAt: new Date()
                    };
                    
                    if (modelsWithUpdatedBy.has(model)) {
                        updateData.updatedBy = userId;
                    }

                    return (prismaClient as any)[model].update({
                        where: args.where,
                        data: updateData
                    });
                }
                return query(args);
            },
            async deleteMany({ model, args, query }) {
                if (modelsWithSoftDelete.has(model)) {
                    const { userId } = getContext();
                    
                    const updateData: any = {
                        isDeleted: true,
                        updatedAt: new Date()
                    };
                    
                    if (modelsWithUpdatedBy.has(model)) {
                        updateData.updatedBy = userId;
                    }

                    return (prismaClient as any)[model].updateMany({
                        where: args.where,
                        data: updateData
                    });
                }
                return query(args);
            }
        }
    }
});

export default prisma;
