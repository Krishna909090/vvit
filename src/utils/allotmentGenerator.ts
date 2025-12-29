import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';

interface AllotmentData {
    applicationId: string;
    studentName: string;
    fatherName: string;
    category: string;
    allottedCourse: string;
    allottedCollege: string;
    admissionFee: number;
    tuitionFee: number;
    date: Date;
    academicYear: string;
}

export const generateAllotmentOrderPDF = async (data: AllotmentData): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', (err) => reject(err));

            generateHeader(doc);
            generateTitle(doc);
            generateStudentDetails(doc, data);
            generateAllotmentDetails(doc, data);
            generateInstructions(doc);
            generateFooter(doc);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
};

function generateHeader(doc: PDFKit.PDFDocument) {
    const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
    if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 50 });
    }

    doc.fillColor('#444444')
        .fontSize(20)
        .text('VVIT University', 110, 57)
        .fontSize(10)
        .text('Nambur, Guntur, Andhra Pradesh', 200, 65, { align: 'right' })
        .text('www.vvitedu.in', 200, 80, { align: 'right' })
        .moveDown();

    doc.moveTo(50, 105).lineTo(550, 105).stroke();
}

function generateTitle(doc: PDFKit.PDFDocument) {
    doc.moveDown(2);
    doc.fillColor('#000000')
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('PROVISIONAL ALLOTMENT ORDER', { align: 'center' });
    doc.moveDown(1);
}

function generateStudentDetails(doc: PDFKit.PDFDocument, data: AllotmentData) {
    const startX = 50;
    let currentY = doc.y;

    doc.fontSize(12).font('Helvetica-Bold').text('Candidate Details:', startX, currentY);
    currentY += 20;

    doc.font('Helvetica').fontSize(11);
    
    // Table-like structure
    const details = [
        { label: 'Application ID', value: data.applicationId },
        { label: 'Candidate Name', value: data.studentName },
        { label: 'Father\'s Name', value: data.fatherName },
        { label: 'Category', value: data.category }
    ];

    details.forEach(item => {
        doc.text(item.label, startX, currentY);
        doc.text(':', startX + 100, currentY);
        doc.font('Helvetica-Bold').text(item.value, startX + 120, currentY);
        doc.font('Helvetica');
        currentY += 20;
    });

    doc.moveDown(1);
}

function generateAllotmentDetails(doc: PDFKit.PDFDocument, data: AllotmentData) {
    const startX = 50;
    let currentY = doc.y;

    doc.fontSize(12).font('Helvetica-Bold').text('Allotment Details:', startX, currentY);
    currentY += 20;

    doc.rect(startX, currentY, 500, 120).stroke(); // Box for details

    const padX = startX + 10;
    const padY = currentY + 10;
    let internalY = padY;

    doc.font('Helvetica').fontSize(11);

    doc.text('Allotted College', padX, internalY);
    doc.text(':', padX + 120, internalY);
    doc.font('Helvetica-Bold').text(data.allottedCollege, padX + 140, internalY);
    doc.font('Helvetica');
    internalY += 25;

    doc.text('Allotted Course', padX, internalY);
    doc.text(':', padX + 120, internalY);
    doc.font('Helvetica-Bold').text(data.allottedCourse, padX + 140, internalY);
    doc.font('Helvetica');
    internalY += 25;

    doc.text('Academic Year', padX, internalY);
    doc.text(':', padX + 120, internalY);
    doc.text(data.academicYear, padX + 140, internalY);
    internalY += 25;

    doc.text('Admission Fee Paid', padX, internalY);
    doc.text(':', padX + 120, internalY);
    doc.text(`INR ${data.admissionFee}`, padX + 140, internalY);
    internalY += 25;

    doc.y = currentY + 130;
    doc.moveDown(1);
}

function generateInstructions(doc: PDFKit.PDFDocument) {
    doc.fontSize(12).font('Helvetica-Bold').text('Instructions to Candidate:');
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    const instructions = [
        "1. Report to the college with all original certificates for verification.",
        "2. This allotment is provisional and subject to verification of eligibility and original documents.",
        "3. The college reserves the right to cancel admission if any information provided is found to be false.",
        "4. Classes will commence as per the schedule notified on the college website."
    ];

    instructions.forEach(inst => {
        doc.text(inst, { align: 'justify' });
        doc.moveDown(0.3);
    });
}

function generateFooter(doc: PDFKit.PDFDocument) {
    const bottomY = 700;
    doc.fontSize(10).font('Helvetica');
    
    doc.text('Date: ' + format(new Date(), 'dd/MM/yyyy'), 50, bottomY);
    
    doc.text('Principal / Admission Officer', 400, bottomY, { align: 'center' });
    doc.text('(Digitally Signed)', 400, bottomY + 15, { align: 'center' });

    doc.fontSize(8).text(
        'This is a computer generated document and does not require a physical signature.',
        50,
        750,
        { align: 'center', width: 500 }
    );
}
