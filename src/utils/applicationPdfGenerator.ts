
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';
import logger from './logger';
import axios from 'axios';

export interface ApplicationData {
    applicationId: string;
    studentName: string;
    dob: Date;
    gender: string;
    phone: string;
    email: string | null;
    address: string;
    city: string;
    state: string;
    pincode: string;
    profilePhotoUrl: string | null;
    
    fatherName: string;
    motherName: string;
    category: string;
    
    // Admission
    courseName?: string;
    quotaType?: string;
    admissionStatus?: string;
    
    // Academic Qualifications
    qualifications: Array<{
        level: string;
        institution: string;
        board: string;
        yearOfPassing: string;
        percentage: number;
    }>;
    
    documents: Array<{
        name: string;
        status: string;
    }>;
}

export const generateApplicationPDF = async (data: ApplicationData): Promise<Buffer> => {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            // --- 1. Header (University Branding) ---
            const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
            let currentY = 40;

            // University Name
            doc.font('Helvetica-Bold')
               .fontSize(14)
               .fillColor('#C0392B')
               .text('VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY', 0, currentY, { align: 'center', width: doc.page.width });
            
            currentY += 25;
            doc.fontSize(10).fillColor('#555555')
               .text('Uppalapadu Road, Nambur, pedakakani Mandal, Guntur, Andhra Pradesh – 522508', 0, currentY, { align: 'center', width: doc.page.width });

            // Logo
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 40, 40, { width: 70 });
            }

            currentY += 40;
            drawLine(doc, currentY);
            currentY += 20;

            // Title
            doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000')
               .text('STUDENT APPLICATION FORM', 0, currentY, { align: 'center' });
            
            currentY += 30;

            // --- 2. Personal Information & Photo ---
            const startX = 40;
            const col1X = 40;
            const col1ValueX = 160;
            const col2X = 300; // Not using 2 columns for text, but keeping space for photo
            
            // Photo Position (Right side)
            const photoX = 420;
            const photoY = currentY;
            const photoWidth = 110;
            const photoHeight = 130;

            doc.rect(photoX, photoY, photoWidth, photoHeight).stroke();
            
            if (data.profilePhotoUrl) {
                try {
                    const response = await axios.get(data.profilePhotoUrl, { responseType: 'arraybuffer' });
                    const img = Buffer.from(response.data);
                    doc.image(img, photoX, photoY, { width: photoWidth, height: photoHeight, fit: [photoWidth, photoHeight] });
                } catch (e) {
                    logger.warn(`Failed to fetch profile photo: ${e}`);
                    doc.text('Photo', photoX + 30, photoY + 60);
                }
            } else {
                doc.text('Photo', photoX + 30, photoY + 60);
            }

            // Personal Details (Left Side)
            doc.font('Helvetica-Bold').fontSize(12).text('Personal Details', col1X, currentY);
            currentY += 20;
            
            const drawField = (label: string, value: string) => {
                doc.font('Helvetica-Bold').fontSize(10).text(label, col1X, currentY);
                doc.font('Helvetica').text(`:  ${value}`, col1ValueX, currentY);
                currentY += 18;
            };

            drawField('Application ID', data.applicationId || 'N/A');
            drawField('Full Name', data.studentName);
            drawField('Date of Birth', data.dob ? format(data.dob, 'dd MMM yyyy') : 'N/A');
            drawField('Gender', data.gender);
            drawField('Category', data.category);
            drawField('Father Name', data.fatherName);
            drawField('Mother Name', data.motherName);
            drawField('Phone', data.phone);
            drawField('Email', data.email || 'N/A');
            
            // Allow wrapping for address
            const addr = `${data.address}, ${data.city}, ${data.state} - ${data.pincode}`;
            doc.font('Helvetica-Bold').fontSize(10).text('Address', col1X, currentY);
            doc.font('Helvetica').text(`:  ${addr}`, col1ValueX, currentY, { width: 240 }); // Limit width to avoid hitting photo
            
            // Move Y down past the photo if text was short, or past text if it was long
            // Address might take multiple lines, so we get Y from doc
            currentY = Math.max(doc.y, photoY + photoHeight) + 20;

            // --- 3. Admission Details ---
            drawSectionHeader(doc, 'Admission Details', currentY);
            currentY += 25;

            // Using columns for admission details
            const admCol1 = 40;
            const admCol2 = 300;
            const admRowY = currentY;

            doc.font('Helvetica-Bold').text('Course Applied:', admCol1, currentY);
            doc.font('Helvetica').text(data.courseName || 'N/A', admCol1 + 100, currentY);
            
            doc.font('Helvetica-Bold').text('Quota Type:', admCol2, currentY);
            doc.font('Helvetica').text(data.quotaType || 'N/A', admCol2 + 80, currentY);
            
            currentY += 20;
            doc.font('Helvetica-Bold').text('Entry Status:', admCol1, currentY);
            doc.font('Helvetica').text(data.admissionStatus || 'N/A', admCol1 + 100, currentY);

            currentY += 30;

            // --- 4. Academic Qualifications ---
            drawSectionHeader(doc, 'Academic Qualifications', currentY);
            currentY += 25;

            // Table Header
            const tX = 40;
            const colLevel = tX;
            const colInst = tX + 100; // Institution
            const colBoard = tX + 250;
            const colYear = tX + 380;
            const colScore = tX + 460;

            doc.rect(tX, currentY, 515, 20).fill('#f0f0f0');
            doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
            
            doc.text('Level', colLevel + 5, currentY + 6);
            doc.text('Institution', colInst + 5, currentY + 6);
            doc.text('Board/Univ', colBoard + 5, currentY + 6);
            doc.text('Year', colYear + 5, currentY + 6);
            doc.text('Percentage', colScore + 5, currentY + 6);

            currentY += 20;

            if (data.qualifications && data.qualifications.length > 0) {
                doc.font('Helvetica').fontSize(9);
                data.qualifications.forEach((qual) => {
                    // Border
                    doc.rect(tX, currentY, 515, 20).stroke();
                    
                    doc.text(qual.level, colLevel + 5, currentY + 6);
                    doc.text(qual.institution, colInst + 5, currentY + 6, { width: 140, lineBreak: false, ellipsis: true });
                    doc.text(qual.board, colBoard + 5, currentY + 6, { width: 120, lineBreak: false, ellipsis: true });
                    doc.text(qual.yearOfPassing, colYear + 5, currentY + 6);
                    doc.text(`${qual.percentage}%`, colScore + 5, currentY + 6);
                    currentY += 20;
                });
            } else {
                 doc.rect(tX, currentY, 515, 20).stroke();
                 doc.text('No qualifications added.', tX + 5, currentY + 6);
                 currentY += 20;
            }

            currentY += 20;

           // --- 5. Documents Submitted ---
           // Check if space remains, else add page
           if (currentY > 650) {
               doc.addPage();
               currentY = 40;
           }

           drawSectionHeader(doc, 'Documents Submitted', currentY);
           currentY += 25;

           if (data.documents && data.documents.length > 0) {
                const docCol1 = 40;
                const docCol2 = 300;
                let isRight = false;
                let rowStartY = currentY;

                data.documents.forEach((d) => {
                    const x = isRight ? docCol2 : docCol1;
                    const y = rowStartY;
                    
                    // Checkbox icon (simulated)
                    const isVerified = d.status === 'VERIFIED';
                    const icon = isVerified ? '[/]' : '[ ]'; // Simple text representation or draw rect
                    
                    doc.rect(x, y, 10, 10).stroke();
                    if (isVerified) {
                        // Draw tick
                        doc.moveTo(x+2, y+5).lineTo(x+4, y+8).lineTo(x+8, y+2).stroke();
                    }

                    doc.fontSize(10).font('Helvetica').text(d.name, x + 20, y - 1);
                    
                    if (isRight) {
                        rowStartY += 20;
                    }
                    isRight = !isRight;
                });
                currentY = rowStartY + 30;
           } else {
            doc.fontSize(10).text('No documents record found.', 40, currentY);
            currentY += 20;
           }

            // --- Footer ---
            const bottomY = doc.page.height - 50;
            const dateStr = new Date().toLocaleString('en-IN');
            
            doc.fontSize(8).fillColor('#95a5a6')
               .text(`Application Generated on: ${dateStr}`, 40, bottomY);
            
            doc.text('This is a computer generated document.', 40, bottomY + 12);


            doc.end();

        } catch (error) {
            reject(error);
        }
    });
}

function drawLine(doc: PDFKit.PDFDocument, y: number) {
    doc.strokeColor('#ecf0f1').lineWidth(1)
       .moveTo(40, y).lineTo(555, y).stroke();
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, y: number) {
    doc.rect(40, y, 515, 20).fill('#34495e'); // Dark Blue Header
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), 50, y + 5);
    doc.fillColor('#000000'); // Reset
}
