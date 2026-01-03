import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';

export interface AllotmentData {
    applicationId: string;
    studentName: string;
    fatherName: string;
    gender: string;
    category: string;
    region: string; // e.g. AU, SVU
    rank: string;
    hallTicketNo: string;
    allottedCollege: string;
    allottedCourse: string;
    allottedCategory: string; // e.g. SC_GEN_AU
    tuitionFeeFixed: number;
    tuitionFeeToPay: number;
    reportingDate: string; // "26.07.2025"
    phase: string; // "First Phase"
    feeReimbursement: string; // "YES" or "NO"
}

export const generateAllotmentOrderPDF = async (data: AllotmentData): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', (err) => reject(err));

            drawHeader(doc);
            drawStudentTable(doc, data);
            drawAllotmentBody(doc, data);
            drawInstructions(doc, data);
            drawFooter(doc);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
};

function drawHeader(doc: PDFKit.PDFDocument) {
    const logoLeft = path.join(process.cwd(), 'src/assets/govt_logo.png'); // Placeholder path
    const logoRight = path.join(process.cwd(), 'src/assets/council_logo.png'); // Placeholder path

    // If logos exist, draw them. For now, we simulate positioning.
    // doc.image(logoLeft, 40, 30, { width: 50 });
    // doc.image(logoRight, 500, 30, { width: 50 });

    doc.font('Helvetica-Bold');
    doc.fontSize(10);
    
    const startY = 40;
    doc.text('DEPARTMENT OF TECHNICAL EDUCATION', 100, startY, { align: 'center', width: 400 });
    doc.text('&', 100, startY + 12, { align: 'center', width: 400 });
    doc.text('ANDHRA PRADESH STATE COUNCIL OF HIGHER EDUCATION', 100, startY + 24, { align: 'center', width: 400 });
    
    doc.fontSize(12).fillColor('#000000');
    doc.text('APEAPCET - 2025 ADMISSIONS', 100, startY + 45, { align: 'center', width: 400 });
    
    // Draw box around header
    doc.lineWidth(0.5).rect(40, 30, 515, 75).stroke();
    
    // Vertical lines for logos (simulated if logos were there)
    doc.moveTo(110, 30).lineTo(110, 105).stroke();
    doc.moveTo(485, 30).lineTo(485, 105).stroke();
}

function drawStudentTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
    const startY = 105; // Connected to header
    const col1X = 40;
    const col2X = 140; // Value starts
    const col3X = 300; // middle line
    const col4X = 400; // Value starts
    const rowHeight = 35; // increased height to accommodate wrapping if needed
    
    // Draw Grid
    doc.rect(40, startY, 515, rowHeight * 3).stroke();
    
    // Horizontal lines
    doc.moveTo(40, startY + rowHeight).lineTo(555, startY + rowHeight).stroke();
    doc.moveTo(40, startY + rowHeight * 2).lineTo(555, startY + rowHeight * 2).stroke();
    
    // Vertical lines
    doc.moveTo(140, startY).lineTo(140, startY + rowHeight * 3).stroke(); // Split Label/Value 1
    doc.moveTo(300, startY).lineTo(300, startY + rowHeight * 3).stroke(); // Middle Split
    doc.moveTo(400, startY).lineTo(400, startY + rowHeight * 3).stroke(); // Split Label/Value 2

    // Content
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    
    // Row 1
    // Hall Ticket No
    drawCell(doc, 'Hall Ticket No.', col1X + 5, startY + 12);
    doc.font('Helvetica').text(data.hallTicketNo, col2X + 5, startY + 12);
    
    // Rank
    doc.font('Helvetica-Bold').text('Rank', col3X + 5, startY + 12);
    doc.font('Helvetica').text(data.rank, col4X + 5, startY + 12);

    // Row 2
    const r2Y = startY + rowHeight;
    doc.font('Helvetica-Bold').text("Candidate's Name", col1X + 5, r2Y + 12, { width: 90 });
    doc.font('Helvetica').text(data.studentName.toUpperCase(), col2X + 5, r2Y + 12, { width: 150 });
    
    doc.font('Helvetica-Bold').text("Father's Name", col3X + 5, r2Y + 12);
    doc.font('Helvetica').text(data.fatherName.toUpperCase(), col4X + 5, r2Y + 12, { width: 150 });

    // Row 3
    const r3Y = startY + rowHeight * 2;
    doc.font('Helvetica-Bold').text('Gender / Region', col1X + 5, r3Y + 12);
    doc.font('Helvetica').text(`${data.gender} / ${data.region}`, col2X + 5, r3Y + 12);
    
    doc.font('Helvetica-Bold').text('Caste / Fee Reimb.', col3X + 5, r3Y + 12);
    doc.font('Helvetica').text(`${data.category} / ${data.feeReimbursement}`, col4X + 5, r3Y + 12);
}

function drawCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number) {
    doc.text(text, x, y);
}

function drawAllotmentBody(doc: PDFKit.PDFDocument, data: AllotmentData) {
    let y = 220;
    
    // Title
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000080'); // Dark Blue
    doc.text(`PROVISIONAL ALLOTMENT ORDER (${data.phase})`, 40, y, { align: 'center', width: 515 });
    
    y += 25;
    
    // Paragraph
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    const text = `This is to inform that the options exercised by the candidate have been processed for allotment of seat in Colleges/Institutions based on rank, local area, gender, category, EWS, Special Reservation Category (CAP/PWD/SCOUTS) etc. The Convenor, APEAPCET-2025 admissions is pleased to allot a seat to the above candidate in`;
    doc.text(text, 40, y, { align: 'justify', width: 515 }); //, block: true 
    
    y += 45;
    
    // Allotment Details (Center aligned bold)
    doc.font('Helvetica-Bold').fontSize(10);
    // College
    doc.text(`${data.allottedCollege}`, 40, y, { align: 'center', width: 515 });
    y += 15;
    // Course
    doc.text(`in ${data.allottedCourse}`, 40, y, { align: 'center', width: 515 });
    y += 15;
    // Category
    doc.text(`under ${data.allottedCategory} category.`, 40, y, { align: 'center', width: 515 });
    
    y += 25;
    
    // Fee Details
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`Tuition Fee fixed for the college/course is Rs. ${data.tuitionFeeFixed} /-`, 40, y, { align: 'center', width: 515 });
    y += 15;
    doc.text(`Tuition fee to be paid by the candidate at the time of admission is Rs. ${data.tuitionFeeToPay} /-`, 40, y, { align: 'center', width: 515 });
}

function drawInstructions(doc: PDFKit.PDFDocument, data: AllotmentData) {
    let y = 370;
    
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
    doc.text('Instructions to Candidates', 40, y);
    y += 15;
    
    doc.font('Helvetica').fontSize(9);
    
    const instructions = [
        `1. The candidate is instructed to download the allotment order from https://cets.apsche.ap.gov.in`,
        `2. The candidate is instructed to report by clicking on "Download of Allotment Order" under "Forms" tab from website https://cets.apsche.ap.gov.in`,
        `3. Further, the candidate is instructed to take print out of two copies of joining report and allotment order and report to the allotted College. Submit a copy of joining report, allotment order and obtain acknowledgement on 2nd copy of joining report from the College where candidate has reported and retain the acknowledged copy with the candidate.`,
        `4. The candidate is instructed that self-reporting in portal and physical reporting at the allotted college is compulsory to retain the present allotment. The last date for self-reporting and reporting at the allotted college is ${data.reportingDate}.`,
        `5. If the candidate does not report through self-reporting system and/or not physically reporting at the allotted college, the provisional allotment will be treated as a vacancy for the subsequent phase and the provisional allotment of ${data.phase} of APEAPCET-2025 Admissions will automatically stands cancelled and the candidate has no claim on the seat allotted. Further, if the candidate reports through self-reporting and does not report physically at the college on or before ${data.reportingDate}, the candidate's allotment/admission will be cancelled.`
    ];

    instructions.forEach(inst => {
        doc.text(inst, 40, y, { align: 'justify', width: 515 });
        y += doc.heightOfString(inst, { width: 515 }) + 8;
    });
}

function drawFooter(doc: PDFKit.PDFDocument) {
    const bottomY = 750;
    doc.fontSize(8).fillColor('#444');
    doc.text('https://eapcet-sche.aptonline.in/EAPCET/eapAllotment/getAllotmentP1', 40, bottomY);
    doc.text('1/2', 540, bottomY);
}
