import PDFDocument from 'pdfkit';
import path from 'path';
import axios from 'axios';
import logger from './logger';

interface HallTicketData {
    studentName: string;
    applicationId: string;
    rollNumber?: string;
    fatherName?: string;
    motherName?: string;
    examCenterName: string;
    examCenterAddress?: string; // Added field
    examDate: string;
    startTime: string;
    endTime: string;
    profilePhotoUrl: string;
    qrCodeBuffer: Buffer;
    session?: string;
    program?: string;
}

export const generateHallTicketPDF = async (data: HallTicketData): Promise<Buffer> => {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 20 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });
            doc.on('error', (err) => {
                reject(err);
            });

            // --- Constants ---
            const pageWidth = 595.28; // A4 width in points
            const contentWidth = 555.28; // With 20px margin
            const startX = 20;
            let currentY = 20;

            // --- 1. Outer Border (Page Container) ---
            doc.rect(startX, currentY, contentWidth, 780).stroke(); // Full page border

            // --- 2. Header ---
            // Logo
            // --- 2. Header ---
            
            // University Header - Centered at top
            doc
                .font('Helvetica-Bold')
                .fontSize(11) // Smaller font for long name
                .fillColor('#C0392B')
                .text('VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY', 0, currentY, { align: 'center', width: pageWidth });

            // Logo
            const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
            const logoWidth = 80;
            const logoHeight = 80; // Assuming ~square aspect ratio for layout reservation
            const logoY = currentY + 30;

            try {
                // Logo top-left
                doc.image(logoPath, startX + 10, logoY, { width: logoWidth }); 
            } catch (logoErr) {
                logger.warn('Logo file not found, skipping logo render.');
                doc.fontSize(10).text('VVITU', startX + 10, logoY);
            }

            // Adjust Y to clear the header area
            // We need space for text (20) + padding (10) + Logo (80) + padding (20)
            currentY += 130;  

            // Hall Ticket Title
            doc.font('Helvetica-Bold').fontSize(14).text('Hall Ticket – Entrance Examination', 0, currentY, { align: 'center' });
            
            currentY += 30;

            // --- 3. Strip (Session | Program) ---
            doc.rect(startX + 2, currentY, contentWidth - 4, 25).fill('#3a3a3a');
            doc.fillColor('white').fontSize(10);
            
            const sessionText = data.session || 'Session: Morning';
            const programText = data.program || 'Program: B.Tech';

            doc.text(sessionText, startX + 10, currentY + 7);
            doc.text(programText, startX + contentWidth - 10 - doc.widthOfString(programText), currentY + 7);

            // Reset color
            doc.fillColor('black');
            currentY += 35;

            // --- 4. Student Info + Photo/QR ---
            const infoStartX = startX + 10;
            const infoStartY = currentY;
            
            // Layout: Info (Left) | QR (Middle-Right) | Photo (Right)
            // Info takes ~300px
            // QR starts at ~330
            // Photo starts at ~450
            
            const qrX = startX + 330;
            const photoX = startX + 440;
            
            doc.fontSize(11).font('Helvetica');

            // Left: Text Details
            const labelX = infoStartX;
            const valueX = infoStartX + 120;
            const rowHeight = 20;

            const drawField = (label: string, value: string, y: number) => {
                doc.font('Helvetica-Bold').text(label, labelX, y);
                doc.font('Helvetica').text(`:  ${value}`, valueX, y);
            };

            drawField('Application ID', data.applicationId, currentY);
            currentY += rowHeight;
            if (data.rollNumber) {
                drawField('Roll No', data.rollNumber, currentY);
                currentY += rowHeight;
            }
            drawField('Name', data.studentName, currentY);
            currentY += rowHeight;
            drawField('Father\'s Name', data.fatherName || 'N/A', currentY);
            currentY += rowHeight;
            drawField('Mother\'s Name', data.motherName || 'N/A', currentY);
            
            // Side-by-Side: QR & Photo
            
            // QR Code
            doc.image(data.qrCodeBuffer, qrX, infoStartY, { width: 100, height: 100 });
            
            // Photo
            const photoHeight = 120;
            const photoWidth = 100;
            // No vertical offset, same Y as fields/QR
            
            if (data.profilePhotoUrl) {
                try {
                     const response = await axios.get(data.profilePhotoUrl, { responseType: 'arraybuffer' });
                     const img = Buffer.from(response.data);
                     doc.image(img, photoX, infoStartY, { width: photoWidth, height: photoHeight, fit: [photoWidth, photoHeight] });
                     doc.rect(photoX, infoStartY, photoWidth, photoHeight).stroke(); // Border for photo
                } catch (e) {
                    logger.warn(`Failed to fetch profile photo for PDF: ${e}`);
                    doc.rect(photoX, infoStartY, photoWidth, photoHeight).stroke();
                    doc.text('Photo', photoX + 30, infoStartY + 50);
                }
            } else {
                 doc.rect(photoX, infoStartY, photoWidth, photoHeight).stroke();
                 doc.text('Photo', photoX + 30, infoStartY + 50);
            }

            // Adjust Y to below the photo/QR section for safety
            // Photo is 120 high, row starts at infoStartY
            // Fields might be fewer (5 fields * 20 = 100px)
            const contentHeight = Math.max(120, (currentY - infoStartY)); 
            currentY = infoStartY + contentHeight + 20;

            // --- 5. Meta Info (Download Time, IP) ---
            doc.rect(startX + 2, currentY, contentWidth - 4, 25).stroke();
            doc.fontSize(9).font('Helvetica');
            const downloadTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            
            doc.text(`Downloaded On: ${downloadTime}`, startX + 10, currentY + 8);
            // doc.text(`IP Address: ${data.ip || 'N/A'}`, startX + contentWidth / 2, currentY + 8); // IP not passed yet

            currentY += 35;

            // --- 6. Exam Center ---
            doc.rect(startX + 2, currentY, contentWidth - 4, 40).stroke();
            doc.font('Helvetica-Bold').fontSize(11).text('Exam Center:', startX + 10, currentY + 12);
            doc.font('Helvetica').text(`${data.examCenterName} - ${data.examCenterAddress || 'See address below'}`, startX + 90, currentY + 12);
            
            currentY += 50;

            // --- 7. Subject Table ---
            const col1 = startX + 2;
            const col2 = startX + 120;
            const col3 = startX + 350;
            const tableWidth = contentWidth - 4;
            
            // Header
            doc.rect(col1, currentY, tableWidth, 20).fill('#f0f0f0');
            doc.fillColor('black').font('Helvetica-Bold').fontSize(10);
            doc.rect(col1, currentY, tableWidth, 20).stroke(); // Border
            
            doc.text('Subject Code', col1 + 5, currentY + 6);
            doc.text('Subject Name', col2 + 5, currentY + 6);
            doc.text('Date & Time of Exam', col3 + 5, currentY + 6);

            currentY += 20;

            // Row 1 (Entrance Exam)
            doc.font('Helvetica').fontSize(10);
            doc.rect(col1, currentY, tableWidth, 20).stroke();
            
            doc.text('ENT-01', col1 + 5, currentY + 6);
            doc.text('Entrance Examination', col2 + 5, currentY + 6);
            doc.text(`${data.examDate} (${data.startTime} - ${data.endTime})`, col3 + 5, currentY + 6);

            currentY += 30;

            // --- 8. Instructions ---
            doc.font('Helvetica-Bold').fontSize(11).text('Important Instructions', startX + 10, currentY);
            currentY += 15;
            doc.font('Helvetica').fontSize(10);
            
            const instructions = [
                'Candidate must carry original ID proof (Aadhar/PAN/Voter ID) along with this hall ticket.',
                'Electronic gadgets (Calculators, Mobile Phones, Smart Watches) are strictly prohibited inside the exam hall.',
                'Candidates should report to the exam center at least 30 minutes before the scheduled time.',
                'Late entry will not be permitted under any circumstances.',
                'The Hall Ticket is non-transferable.'
            ];

            instructions.forEach((inst, index) => {
                doc.text(`${index + 1}. ${inst}`, startX + 20, currentY);
                currentY += 14;
            });

            // --- 9. Footer Disclaimer ---
            currentY += 20;
            doc.moveTo(startX, currentY).lineTo(startX + contentWidth, currentY).stroke(); // Line
            currentY += 10;
            doc.fontSize(9).font('Helvetica-Oblique').text(
                'VVIT University is not responsible for any inadvertent error in this hall ticket. This is a computer generated document.', 
                startX + 10, 
                currentY, 
                { width: contentWidth - 20, align: 'center' }
            );

            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};
