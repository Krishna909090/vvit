
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const expectedColumns = [
  'id', 'applicationId', 'name', 'fatherName', 'motherName', 'gender', 'dob', 'phone', 'email',
  'aadharNumber', 'category', 'country', 'address', 'address2', 'city', 'state', 'pincode',
  'profilePhotoUrl', 'documentFolderPath', 'source', 'quotaType', 'applicationMode', 'isOffline',
  'isKycVerified', 'pref1', 'pref2', 'pref3', 'userId', 'agentId', 'eligibleScholarshipRuleId',
  'degreeType', 'courseType', 'scholarshipRemarks', 'scholarshipVerified', 'scholarshipVerifiedAt',
  'scholarshipVerifiedBy', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'
];

async function checkStudentTable() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database.');

    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'Student' 
      ORDER BY column_name;
    `);

    const existingColumns = res.rows.map(r => r.column_name);
    console.log(`Found ${existingColumns.length} columns in "Student" table:`);
    console.log(existingColumns.join(', '));

    const missingColumns = expectedColumns.filter(c => !existingColumns.includes(c));
    
    if (missingColumns.length > 0) {
      console.log('\n❌ MISSING COLUMNS (defined in Prisma schema but not in DB):');
      missingColumns.forEach(c => console.log(` - ${c}`));
    } else {
      console.log('\n✅ All expected columns seem to be present.');
    }

  } catch (err) {
    console.error('Error querying database:', err);
  } finally {
    await client.end();
  }
}

checkStudentTable();
