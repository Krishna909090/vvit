import PDFDocument from 'pdfkit';
import path from 'path';
import axios from 'axios';
import fs from 'fs';
import { format } from 'date-fns';

export interface FeeComponent {
    name: string;
    amount: number;
}

export interface AllotmentData {
    applicationId: string;
    studentName: string;
    fatherName: string;
    gender: string;
    region: string;
    allottedCollege: string;
    allottedCourse: string;
    allottedCategory: string;
    reportingDate: string;
    phase: string;
    feeReimbursement: string;
    profilePhotoUrl?: string; 
    
    // Fee Details
    feeBreakdown: FeeComponent[];
    totalFee: number;
    totalPaid: number;
}

async function fetchImage(url: string): Promise<Buffer | null> {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (e) {
        return null;
    }
}

export const generateAllotmentOrderPDF = async (data: AllotmentData): Promise<Buffer> => {
    let photoBuffer: Buffer | null = null;
    if (data.profilePhotoUrl) {
        photoBuffer = await fetchImage(data.profilePhotoUrl);
    }

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', (err) => reject(err));

            drawHeader(doc, photoBuffer);
            drawStudentTable(doc, data);
            drawAllotmentBody(doc, data);
            drawFeeTable(doc, data);
            drawInstructions(doc, data);
            drawFooter(doc);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
};

function drawHeader(doc: PDFKit.PDFDocument, photoBuffer: Buffer | null) {
    const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png');
    const fallbackLogo = path.join(process.cwd(), 'src/assets/logo.png');

    // Logo Left
    if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 40, 30, { width: 60 });
    } else if (fs.existsSync(fallbackLogo)) {
        doc.image(fallbackLogo, 40, 30, { width: 60 });
    }

    // Photo Right
    if (photoBuffer) {
        doc.image(photoBuffer, 480, 30, { width: 70, height: 80 }); 
        doc.rect(480, 30, 70, 80).stroke(); 
    } else {
        doc.rect(480, 30, 70, 80).stroke();
        doc.fontSize(8).text('PHOTO', 480, 65, { width: 70, align: 'center' });
    }

    // Center Text
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#800000'); 
    doc.text('VVIT UNIVERSITY', 110, 40, { align: 'center', width: 360 });
    
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    doc.text('(Established under Andhra Pradesh Private Universities Act 2016)', 110, 65, { align: 'center', width: 360 });
    doc.text('Nambur (V), Peda Kakani (Md), Guntur (Dt) - 522508', 110, 80, { align: 'center', width: 360 });
    doc.text('Guntur District, Andhra Pradesh, India.', 110, 95, { align: 'center', width: 360 });

    doc.moveTo(40, 120).lineTo(555, 120).stroke();
}

function drawStudentTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
    const startY = 140; 
    const col1X = 40;
    const col2X = 140; 
    const col3X = 300; 
    const col4X = 400; 
    const rowHeight = 35; 
    
    // Removed Row 1 (Hall Ticket / Rank)
    // Removed Row 3 (Caste / Fee Reimb) -> Keeping Fee Reimb merged with Gender/Region?
    // User said remove "caste". 
    // I'll simplify to 2 Rows.

    doc.lineWidth(0.5).rect(40, startY, 515, rowHeight * 2).stroke();
    
    doc.moveTo(40, startY + rowHeight).lineTo(555, startY + rowHeight).stroke();
    
    doc.moveTo(140, startY).lineTo(140, startY + rowHeight * 2).stroke(); 
    doc.moveTo(300, startY).lineTo(300, startY + rowHeight * 2).stroke(); 
    doc.moveTo(400, startY).lineTo(400, startY + rowHeight * 2).stroke(); 

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    
    // Row 1: Candidate Name & Father Name
    drawCell(doc, "Candidate's Name", col1X + 5, startY + 12);
    doc.font('Helvetica').text(data.studentName.toUpperCase(), col2X + 5, startY + 12, { width: 150 });
    
    doc.font('Helvetica-Bold').text("Father's Name", col3X + 5, startY + 12);
    doc.font('Helvetica').text(data.fatherName.toUpperCase(), col4X + 5, startY + 12, { width: 150 });

    // Row 2: Gender/Region & Allotted Category 
    // (Replacing Caste/Fee Reimb with simpler fields)
    const r2Y = startY + rowHeight;
    doc.font('Helvetica-Bold').text('Gender / Region', col1X + 5, r2Y + 12);
    doc.font('Helvetica').text(`${data.gender} / ${data.region}`, col2X + 5, r2Y + 12);
    
    doc.font('Helvetica-Bold').text('Category', col3X + 5, r2Y + 12);
    doc.font('Helvetica').text(data.allottedCategory, col4X + 5, r2Y + 12);
}

function drawCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number) {
    doc.text(text, x, y);
}

function drawAllotmentBody(doc: PDFKit.PDFDocument, data: AllotmentData) {
    let y = 230;
    
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000080'); 
    doc.text(`PROVISIONAL ALLOTMENT ORDER`, 40, y, { align: 'center', width: 515 });
    
    y += 25;
    
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    const text = `This is to inform that the options exercised by the candidate have been processed for allotment of seat in Colleges/Institutions based on rank, local area, gender, category, EWS, Special Reservation Category (CAP/PWD/SCOUTS) etc. The Convenor, APEAPCET-2025 admissions is pleased to allot a seat to the above candidate in`;
    doc.text(text, 40, y, { align: 'justify', width: 515 }); 
    
    y += 45; // specific spacing for long text
    
    // Allotted Details Box
    doc.rect(40, y, 515, 60).stroke();
    
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`College: ${data.allottedCollege}`, 50, y + 10);
    doc.text(`Course: ${data.allottedCourse}`, 50, y + 35);
}

function drawFeeTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
    let y = 330;
    
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
    doc.text('Fee Details:', 40, y);
    y += 15;

    // Table Header
    doc.rect(40, y, 300, 20).fill('#eee').stroke();
    doc.fillColor('#000').text('Description', 50, y + 5);
    doc.text('Amount (Rs)', 250, y + 5);
    
    y += 20;

    // Rows
    data.feeBreakdown.forEach(fee => {
        doc.rect(40, y, 300, 20).stroke();
        doc.font('Helvetica').text(fee.name, 50, y + 5);
        doc.text(fee.amount.toLocaleString('en-IN'), 250, y + 5);
        y += 20;
    });

    // Total Expected
    doc.rect(40, y, 300, 20).stroke();
    doc.font('Helvetica-Bold').text('Total Fee', 50, y + 5);
    doc.text(data.totalFee.toLocaleString('en-IN'), 250, y + 5);
    y += 20;

    // Total Paid
    doc.rect(40, y, 300, 20).stroke();
    doc.fillColor('#008000').text('Total Paid', 50, y + 5); // Green
    doc.text(data.totalPaid.toLocaleString('en-IN'), 250, y + 5);
    y += 20;

    // Balance
    const balance = Math.max(0, data.totalFee - data.totalPaid);
    doc.rect(40, y, 300, 20).stroke();
    doc.fillColor('#FF0000').text('Balance Due', 50, y + 5); // Red
    doc.text(balance.toLocaleString('en-IN'), 250, y + 5);
}

function drawInstructions(doc: PDFKit.PDFDocument, data: AllotmentData) {
    let y = 600; // Push down
    // Ensure we don't overlap if table is long (unlikely)
    if (doc.y > 580) y = doc.y + 20;

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
    doc.text('Instructions to Candidates', 40, y);
    y += 15;
    
    doc.font('Helvetica').fontSize(9);
    
    const instructions = [
        `1. Report to the college with this allotment order.`,
        `2. Pay the balance fee before the due date.`
    ];

    instructions.forEach(inst => {
        doc.text(inst, 40, y, { align: 'justify', width: 515 });
        y += doc.heightOfString(inst, { width: 515 }) + 8;
    });
}

function drawFooter(doc: PDFKit.PDFDocument) {
    const bottomY = 750;
    doc.fontSize(8).fillColor('#444');
    doc.text('Computer Generated Report.', 40, bottomY);
    doc.text('1/1', 540, bottomY);
}
