import dotenv from 'dotenv';
dotenv.config();

import prisma from '../config/prisma';

async function listUnallocatedHostelStudents() {
    const students = await prisma.student.findMany({
        where: {
            admissionDetails: {
                accommodationType: 'HOSTEL',
            },
            OR: [
                { hostelAllocation: null },
                { hostelAllocation: { status: { not: 'ACTIVE' } } },
            ],
        },
        select: {
            applicationId: true,
            name: true,
            phone: true,
            email: true,
            gender: true,
            admissionDetails: {
                select: {
                    hostelType: true,
                    hostelPaymentMode: true,
                    hostel: { select: { name: true } },
                },
            },
            hostelAllocation: {
                select: { status: true },
            },
        },
        orderBy: [
            { admissionDetails: { hostelType: 'asc' } },
            { name: 'asc' },
        ],
    });

    if (students.length === 0) {
        console.log('No hostel-opted students without an active bed allocation.');
        return;
    }

    console.log(`\nFound ${students.length} hostel-opted student(s) without an active bed allocation:\n`);

    const header = ['#', 'App ID', 'Name', 'Gender', 'Phone', 'Hostel Type', 'Assigned Hostel', 'Payment Mode', 'Allocation Status'];
    const rows = students.map((s, i) => [
        String(i + 1),
        s.applicationId ?? '-',
        s.name,
        s.gender,
        s.phone,
        s.admissionDetails?.hostelType ?? '-',
        s.admissionDetails?.hostel?.name ?? '-',
        s.admissionDetails?.hostelPaymentMode ?? '-',
        s.hostelAllocation?.status ?? 'NOT_ALLOCATED',
    ]);

    const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map(r => r[i].length))
    );

    const fmt = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i])).join(' | ');

    console.log(fmt(header));
    console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
    rows.forEach(r => console.log(fmt(r)));
    console.log('');
}

listUnallocatedHostelStudents()
    .catch(err => {
        console.error('Failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
