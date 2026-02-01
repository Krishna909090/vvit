
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';
import axios from 'axios';

export interface ApplicationSummaryData {
  applicationId: string;
  studentName: string;
  fatherName: string;
  motherName: string;
  dob: Date;
  gender: string;
  phone: string;
  email: string;
  address: string;
  degreeType?: string;
  courseType?: string;
  pref1?: string;
  pref2?: string;
  pref3?: string;
  profilePhotoUrl?: string;
  qualifications: {
    level: string; // e.g. SSC, INTERMEDIATE
    institution: string;
    board: string;
    yearOfPassing: string;
    percentage: string;
  }[];
}

export const generateApplicationSummaryPDF = async (data: ApplicationSummaryData): Promise<Buffer> => {
  return new Promise(async (resolve, reject) => {
    try {
      
      let profilePhotoBuffer: Buffer | null = null;
      if (data.profilePhotoUrl) {
          try {
              const response = await axios.get(data.profilePhotoUrl, { responseType: 'arraybuffer' });
              profilePhotoBuffer = Buffer.from(response.data);
          } catch (error) {
              console.error('Failed to download profile photo for summary', error);
          }
      }

      const doc = new PDFDocument({
        size: 'A4',
        margin: 40
      });

      const buffers: Buffer[] = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // --- Header ---
      drawHeader(doc, profilePhotoBuffer);
      
      const startY = 90; // Moved up
      let currentY = startY;

      // --- Title ---
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#C0392B')
         .text('ADMISSION APPLICATION SUMMARY', 0, currentY, { align: 'center' });
      
      currentY += 30;

      // --- Personal Details ---
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#34495e').text('Personal Details', 40, currentY);
      currentY += 15;

      const personalRows = [
        { key: 'Application ID', value: data.applicationId },
        { key: 'Full Name', value: data.studentName.toUpperCase() },
        { key: 'Father Name', value: data.fatherName },
        { key: 'Mother Name', value: data.motherName },
        { key: 'Date of Birth', value: format(new Date(data.dob), 'dd/MM/yyyy') },
        { key: 'Gender', value: data.gender },
        { key: 'Phone', value: data.phone },
        { key: 'Email', value: data.email || 'N/A' },
        { key: 'Address', value: data.address }
      ];

      currentY = drawKeyValueTable(doc, currentY, personalRows);
      currentY += 20;

      // --- Course Preferences ---
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#34495e').text('Course Preferences', 40, currentY);
      currentY += 15;

      const prefRows = [
        { key: 'Degree Type', value: data.degreeType || 'N/A' },
        { key: 'Preference 1', value: data.pref1 || 'N/A' },
        { key: 'Preference 2', value: data.pref2 || 'N/A' },
        { key: 'Preference 3', value: data.pref3 || 'N/A' }
      ];

      currentY = drawKeyValueTable(doc, currentY, prefRows);
      currentY += 20;

      // --- Qualifications ---
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#34495e').text('Academic Qualifications', 40, currentY);
      currentY += 15;

      // Table Header
      drawTable(doc, currentY, headers, data.qualifications);

      // --- Footer ---
      doc.page.margins.bottom = 0;
      doc.text('', 0, 750); // Move to bottom
      doc.font('Helvetica').fontSize(8).fillColor('#7f8c8d')
         .text('This is a system generated summary.', 0, 780, { align: 'center', width: doc.page.width });

      doc.end();

    } catch (err) {
      reject(err);
    }
  });
};

const headers = [
    { label: 'Level', width: 100 },
    { label: 'Institution', width: 220 },
    { label: 'Board', width: 80 },
    { label: 'Year', width: 60 },
    { label: '% / GPA', width: 60 },
  ];

function drawKeyValueTable(doc: PDFKit.PDFDocument, startY: number, rows: {key: string, value: string}[]) {
    let y = startY;
    const col1X = 50;
    const col2X = 200;
    
    // Border Box
    const rowHeight = 20;
    const totalHeight = rows.length * rowHeight;
    
    // Draw Rows
    doc.font('Helvetica').fontSize(10);
    rows.forEach((row, i) => {
        // Striping
        if (i % 2 === 0) doc.fillColor('#f9f9f9').rect(40, y, 520, rowHeight).fill();
        doc.fillColor('#000');
        
        // Key
        doc.font('Helvetica-Bold').text(row.key, col1X, y + 5);
        // Value
        doc.font('Helvetica').text(row.value, col2X, y + 5);
        
        y += rowHeight;
    });

    // Outer Border
    doc.rect(40, startY, 520, totalHeight).strokeColor('#ccc').stroke();

    return y;
}

function drawTable(doc: PDFKit.PDFDocument, startY: number, headers: any[], rows: any[]) {
    let y = startY;
    
    // Draw Header
    doc.fillColor('#f2f2f2').rect(40, y, 520, 20).fill();
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    
    let x = 50;
    headers.forEach(h => {
        doc.text(h.label, x, y + 6);
        x += h.width;
    });

    y += 20;
    
    // Draw Rows
    doc.font('Helvetica').fontSize(9);
    rows.forEach((row, i) => {
        // Striping
        if (i % 2 === 1) doc.fillColor('#f9f9f9').rect(40, y, 520, 20).fill();
        doc.fillColor('#000');

        let rx = 50;
        
        doc.text(row.level || '-', rx, y + 6, { width: 90 }); rx += 100;
        doc.text(row.institution || '-', rx, y + 6, { width: 210 }); rx += 220;
        doc.text(row.board || '-', rx, y + 6, { width: 70 }); rx += 80;
        doc.text(row.yearOfPassing || '-', rx, y + 6, { width: 50 }); rx += 60;
        doc.text(row.percentage || '-', rx, y + 6, { width: 50 }); 
        
        y += 20;
    });

    // Border
    doc.rect(40, startY, 520, y - startY).strokeColor('#ccc').stroke();
}

function drawHeader(doc: PDFKit.PDFDocument, photoBuffer: Buffer | null = null) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png');

  // University name
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#C0392B')
    .text('VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY', 0, 30, { 
        align: 'center',
        width: doc.page.width 
    });

  // Address
  doc.font('Helvetica').fontSize(9).fillColor('#555')
    .text('Nambur, Guntur, Andhra Pradesh – 522508', 0, 50, { align: 'center' });

  if (fs.existsSync(logoPath)) {
    // Moved Logo Down
    doc.image(logoPath, 40, 55, { width: 60 });
  }

  // Profile Photo
  if (photoBuffer) {
      try {
          doc.image(photoBuffer, doc.page.width - 40 - 100, 30, { 
              width: 100, 
              height: 100,
              fit: [100, 100],
              align: 'center',
              valign: 'center'
          });
          // Draw Border around photo
          doc.rect(doc.page.width - 40 - 100, 30, 100, 100).strokeColor('#ccc').stroke();
      } catch (e) {
          console.error('Error drawing profile photo', e);
      }
  }
}
