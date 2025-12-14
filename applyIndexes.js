// applyIndexes.js
// Script to apply performance indexes to the database

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function applyIndexes() {
    try {
        console.log('📊 Applying performance indexes...\n');

        const sqlFile = path.join(__dirname, 'prisma/migrations/add_performance_indexes.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');

        // Split by semicolon and filter out empty statements
        const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

        let successCount = 0;
        let skipCount = 0;

        for (const statement of statements) {
            try {
                await prisma.$executeRawUnsafe(statement);
                const indexName = statement.match(/CREATE INDEX (?:IF NOT EXISTS )?"([^"]+)"/)?.[1] || 'unknown';
                console.log(`✅ Created index: ${indexName}`);
                successCount++;
            } catch (error) {
                if (error.message.includes('already exists')) {
                    const indexName = statement.match(/CREATE INDEX (?:IF NOT EXISTS )?"([^"]+)"/)?.[1] || 'unknown';
                    console.log(`⏭️  Index already exists: ${indexName}`);
                    skipCount++;
                } else {
                    console.error(`❌ Error creating index:`, error.message);
                }
            }
        }

        console.log(`\n📈 Summary:`);
        console.log(`   ✅ Created: ${successCount}`);
        console.log(`   ⏭️  Skipped (already exists): ${skipCount}`);
        console.log(`   📊 Total: ${statements.length}`);
        console.log('\n✨ Performance indexes applied successfully!');

    } catch (error) {
        console.error('❌ Error applying indexes:', error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

applyIndexes();
