
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const checkStudent = async () => {
    const email = "bhsrikrishna1994@gmail.com";
    const aadhar = "949817517700";

    console.log(`Checking for student with Email: ${email} OR Aadhar: ${aadhar}`);

    const existingStudent = await prisma.student.findFirst({
        where: {
            OR: [
                { email: email },
                { aadharNumber: aadhar }
            ]
        },
        select: {
            id: true,
            applicationId: true,
            name: true,
            email: true,
            aadharNumber: true,
            createdAt: true
        }
    });

    if (existingStudent) {
        console.log("--------------------------------------------------");
        console.log("CONFLICT FOUND: Student record already exists!");
        console.log(JSON.stringify(existingStudent, null, 2));
        console.log("--------------------------------------------------");
    } else {
        console.log("--------------------------------------------------");
        console.log("No existing student found with these credentials.");
        console.log("--------------------------------------------------");
    }
};

checkStudent()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
