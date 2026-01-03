
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function debugFeeGeneration() {
    const studentId = '7f94f63b-78c4-43c6-84c7-26c9e09ec5e4';
    // These IDs should match what you used in the generate-demands call
    // From previous turns:
    // MTECH Course: 5ce7eaf3-0e35-4cec-9495-a3969a00578b
    // BTECH Course: 6ac50eca-deff-4cc6-9244-a69f69c253f9
    // Academic Year: 6bb835b9-ba3a-4ba0-9d9a-e406d91cfe61
    
    // Let's check both possibilities
    const courseIds = [
        '5ce7eaf3-0e35-4cec-9495-a3969a00578b', 
        '6ac50eca-deff-4cc6-9244-a69f69c253f9'
    ];
    const academicYearId = '6bb835b9-ba3a-4ba0-9d9a-e406d91cfe61';

    try {
        console.log("--- Student Data ---");
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        console.log(student);
        
        if (!student) {
            console.log("Student not found!");
            return;
        }

        console.log("\n--- Checking Fee Structures ---");
        for (const courseId of courseIds) {
            console.log(`\nChecking Course: ${courseId}`);
            const feeStructures = await prisma.feeStructure.findMany({
                where: {
                    courseId,
                    academicYearId,
                    isDeleted: false
                },
                include: { feeHead: true }
            });
            console.log(`Found ${feeStructures.length} fee structures.`);
            
            const applicableFees = feeStructures.filter(fs => {
                const quotaMatch = (!fs.quotaType || (student.quotaType && fs.quotaType === student.quotaType));
                const courseTypeMatch = (!fs.courseType || (student.courseType && fs.courseType === student.courseType));
                
                console.log(`- Fee: ${fs.feeHead.name} (${fs.amount}) | Quota: ${fs.quotaType} vs ${student.quotaType} (${quotaMatch}) | Type: ${fs.courseType} vs ${student.courseType} (${courseTypeMatch})`);
                
                return quotaMatch && courseTypeMatch;
            });
            
            console.log(`Applicable Fees: ${applicableFees.length}`);
        }
        
        console.log("\n--- Existing Demands ---");
        const demands = await prisma.studentFeeDemand.findMany({
            where: { studentId }
        });
        console.log(demands);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

debugFeeGeneration();
