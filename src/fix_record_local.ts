
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const phone = '9398185097';
    console.log(`Finding student with phone: ${phone}`);

    let student = await prisma.student.findFirst({
        where: { phone: phone }
    });

    if (!student) {
        console.log('Student not found. Creating new student...');
        student = await prisma.student.create({
            data: {
                name: 'Test Student Local',
                fatherName: 'Local Father',
                motherName: 'Local Mother',
                profilePhotoUrl: 'http://example.com/local.jpg',
                phone: phone,
                email: 'test_local_9398@example.com',
                applicationId: 'LOC' + Math.floor(Math.random() * 10000),
                dob: new Date('2000-01-01'),
                gender: 'MALE',
                aadharNumber: '9999' + Math.floor(Math.random() * 100000000),
                address: 'Local Address',
                city: 'Local City',
                state: 'Local State',
                pincode: '500001',
                category: 'GENERAL',
                country: 'India',
                courseType: 'BTECH',
                admissionDetails: {
                    create: {
                        status: 'ENTRANCE_FEE_PAID'
                    }
                },
                examDetails: {
                    create: {}
                }
            }
        });
        console.log('Created new student in LOCAL DB:', student.id);
    } else {
        console.log(`Student found in LOCAL DB: ${student.id}`);
        // Ensure relations
        await prisma.studentExam.upsert({
            where: { studentId: student.id },
            update: {},
            create: { studentId: student.id }
        });
        await prisma.studentAdmission.upsert({
            where: { studentId: student.id },
            update: { status: 'ENTRANCE_FEE_PAID' },
            create: { studentId: student.id, status: 'ENTRANCE_FEE_PAID' }
        });
        console.log('Ensured StudentExam and StudentAdmission in LOCAL DB.');
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
