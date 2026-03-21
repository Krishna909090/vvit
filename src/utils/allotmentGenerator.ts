import PDFDocument from 'pdfkit'
import path from 'path'
import axios from 'axios'
import fs from 'fs'

/* ================= INTERFACES ================= */

export interface AllotmentData {
  applicationId: string
  studentName: string
  fatherName: string
  motherName: string
  gender: string
  state: string
  allottedCollege: string
  allottedCourse: string
  profilePhotoUrl?: string
  totalPending?: number
  scholarshipPercentage?: number
  scholarshipDiscount?: number
  tuitionFee?: number
}

/* ================= HELPERS ================= */

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer' })
    return Buffer.from(res.data)
  } catch (error: any) {
    console.error(`Failed to fetch image from ${url}:`, error.message);
    return null
  }
}

/* ================= MAIN ================= */

export const generateAllotmentOrderPDF = async (
  data: AllotmentData
): Promise<Buffer> => {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 })
      const buffers: Buffer[] = []

      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', reject)

      // 1. Header (Logo Top Center, Address)
      drawHeader(doc)
      drawBigWatermark(doc)

      // 2. Title Section
      drawTitle(doc)

      // 3. Student Details (Left) and Profile Photo (Right)
      //    We must draw Photo FIRST or calculate height to ensure text flows correctly?
      //    Actually we can draw them independently at fixed/calculated Y.
      const detailsEndY = await drawStudentDetailsSection(doc, data);
      
      // 4. Fee Table (Below details)
      doc.y = detailsEndY + 10;
      drawFeeTable(doc, data)

      // 5. Instructions
      drawUniversityInstructions(doc)

      drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

// ... (existing code)

/* ================= FOOTER ================= */

function drawFooter(doc: PDFKit.PDFDocument) {
  const footerText = 'For any queries please contact admission office contact details: 8341098336, 8179488336, 7702943336.';
  
  doc
    .fontSize(9)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(
      footerText,
      40,
      doc.page.height - 60, // Position at bottom
      { width: 515, align: 'center' }
    )
}

function drawHeader(doc: PDFKit.PDFDocument) {
  const startY = 15;
  const logoPath = path.join(process.cwd(), 'src/assets/logo.png')
  
  // 1. LOGO: Top Center
  // Assuming square logo approx 60x60
  if (fs.existsSync(logoPath)) {
    const logoSize = 60;
    const logoX = (doc.page.width - logoSize) / 2;
    doc.image(logoPath, logoX, startY, { width: logoSize })
    
    // Move Y below logo
    doc.y = startY + logoSize + 10;
  } else {
    doc.y = startY;
  }

  // 2. COLLEGE NAME: Centered, Red/Orange
  doc
    .font('Helvetica-Bold')
    .fontSize(16) 
    .fillColor('#E74C3C') // Red/Orange color
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      0, // Left
      doc.y,
      { width: doc.page.width, align: 'center' } 
    )
  
  doc.moveDown(0.3);

  // 3. ADDRESS: Centered, Black, Smaller
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#000000')
    .text(
      'Uppalapadu Road, Nambur, Pedakakani Mandal, Guntur, Andhra Pradesh – 522508',
      { width: doc.page.width, align: 'center' }
    )

  doc.moveDown(0.5);

  // 4. Separator Line (Dashed)
  const lineY = doc.y;
  doc.save();
  doc.strokeColor('#BDC3C7').dash(4, { space: 2 }).lineWidth(1)
     .moveTo(40, lineY).lineTo(doc.page.width - 40, lineY).stroke();
  doc.restore();

  doc.moveDown(0.5);
}

/* ================= TITLE ================= */

function drawTitle(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica-Bold')
    .fontSize(14) 
    .fillColor('#1C2833')
    .text('PROVISIONAL ALLOTMENT ORDER', 0, doc.y, { align: 'center', width: doc.page.width, underline: true })

  doc
    .moveDown(0.3)
    .fontSize(10)
    .fillColor('#566573')
    .text('(Academic Year 2026–2027)', { align: 'center', width: doc.page.width })

  doc.moveDown(0.5) 
}

/* ================= STUDENT DETAILS & PHOTO ================= */

async function drawStudentDetailsSection(doc: PDFKit.PDFDocument, data: AllotmentData): Promise<number> {
  const startY = doc.y;
  const colLabelX = 60;
  const colValueX = 200;
  const lineHeight = 20;

  // Student Details Fields
  const fields = [
    { label: 'Candidate Name', value: data.studentName },
    { label: 'Application ID', value: data.applicationId },
    { label: 'Father Name', value: data.fatherName },
    { label: 'Mother Name', value: data.motherName },
    { label: 'Gender', value: data.gender },
    { label: 'State', value: data.state },
  ];

  // Draw Text
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  
  fields.forEach((field, index) => {
    const y = startY + (index * lineHeight);
    // Label
    doc.text(field.label, colLabelX, y);
    // Colon
    doc.text(':', colValueX - 10, y);
    // Value (Bold?) Image shows bold name? No, regular mostly, Name might be bold.
    if (index === 0) doc.font('Helvetica-Bold');
    doc.text(field.value, colValueX, y);
    if (index === 0) doc.font('Helvetica');
  });

  const textEndY = startY + (fields.length * lineHeight);

  // Draw Profile Photo (Right Side)
  // Aligned with top of text approx.
  if (data.profilePhotoUrl) {
    try {
        const photoBuffer = await fetchImage(data.profilePhotoUrl);
        if (photoBuffer) {
            const photoWidth = 100;
            const photoHeight = 120; // Portrait aspect ratio?
            const photoX = 420; // Right side
            const photoY = startY; 
            
            doc.save();
            // Clip rounded rectangle?
            doc.roundedRect(photoX, photoY, photoWidth, photoHeight, 8).clip();
            doc.image(photoBuffer, photoX, photoY, { fit: [photoWidth, photoHeight] });
            doc.restore();
            // Border
            doc.roundedRect(photoX, photoY, photoWidth, photoHeight, 8).strokeColor('#000').lineWidth(1).stroke();
            
            // Adjust end Y if photo is taller than text
            return Math.max(textEndY, photoY + photoHeight);
        }
    } catch (e) {
        console.error('Error drawing profile photo in new layout', e);
    }
  }

  return textEndY;
}

/* ================= FEE TABLE ================= */

function drawFeeTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
  const startY = doc.y;
  const tableX = 50;
  const tableWidth = 495; // 515? 
  // Image shows table slightly inset?
  const rowHeight = 30;
  const col1W = 250; 
  // Col 2 is the rest

  const rows = [
    { label: 'Allotted Branch', value: data.allottedCourse, highlight: false },
    { label: 'Actual Tuition fee', value: `INR ${(data.tuitionFee || 0).toLocaleString('en-IN')}`, highlight: false },
    { label: 'Scholarship Approved', value: `INR ${(data.scholarshipDiscount || 0).toLocaleString('en-IN')} (${data.scholarshipPercentage || 0}%)`, highlight: false },
    { label: 'Tuition fee payable per year', value: `INR ${((data.tuitionFee || 0) - (data.scholarshipDiscount || 0)).toLocaleString('en-IN')}`, highlight: true }
  ];

  doc.font('Helvetica').fontSize(10);

  let currentY = startY;

  // Draw border rect for whole table
  // Can draw row by row
  
  rows.forEach((row, i) => {
    // Background for Highlight
    if (row.highlight) {
      doc.rect(tableX, currentY, tableWidth, rowHeight).fill('#FEF5E7'); // Light orange/beige
      doc.fillColor('#000'); // Reset fill to black for text
    }

    // Border Rect
    doc.rect(tableX, currentY, tableWidth, rowHeight).strokeColor('#E5E7E9').stroke(); // Light grey border

    // Text Vertical Center
    const textY = currentY + 10;

    // Label
    doc.font('Helvetica').fillColor('#5D6D7E') // Greyish label
    doc.text(row.label, tableX + 20, textY);

    // Value
    doc.font('Helvetica-Bold').fillColor('#000000') // Black bold value
    doc.text(row.value, tableX + col1W, textY);

    currentY += rowHeight;
  });

  doc.y = currentY + 10;
}


/* ================= UNIVERSITY INSTRUCTIONS (Bottom Box) ================= */

function drawUniversityInstructions(doc: PDFKit.PDFDocument) {
  const startY = doc.y;
  
  // If we are too low, add page? 
  // But requirement is single page.
  // We should be around Y=500. Page height is ~840. Space is ample.

  const boxPadding = 10;
  const contentStartY = startY + boxPadding;
  
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#000000')
    .text('Important Conditions of Provisional Admission', 50 + boxPadding, contentStartY, { underline: true })

  doc.moveDown(0.5)

  doc.font('Helvetica').fontSize(8).fillColor('#000')

  const instructions = [
    '1. Provisional Nature of Admission: The admission offered through this letter is purely provisional in nature and is subject to fulfilment of all eligibility requirements as prescribed by VVIT University and statutory authorities.',
    '2. Confirmation of Admission: Confirmation of admission shall be strictly subject to:',
    '   • Submission of all original documents as specified in the separate annexures applicable for UG and PG programmes, and',
    '   • Payment of all applicable fee components, including but not limited to Tuition Fee, Hostel Fee and/or Transportation Fee, within the stipulated time.',
    '3. Change of Branch / Programme: Any request for change of branch or change of programme shall be considered solely at the discretion of the Director – Admissions, subject to availability of seats and eligibility criteria.',
    '   Such requests must be submitted through:',
    '   • Official Email: admissions@vvitu.ac.in',
    '   • Handwritten letter submitted to Director Admissions.',
    '4. Merit Scholarship Condition: Students who are awarded a Merit Scholarship are required to pay the complete applicable fee components on or before the Official Reporting Day, which will be notified separately by the University. Adjustment of scholarship benefits, if any, shall be governed by the University norms.',
    '5. Continuation of Merit Scholarship after 1st year:',
    '   • Attendance, Conduct and Discipline: Candidate must maintain 75% attendance in each Semester and have no history of major disciplinary violations or "code of conduct" breaches.',
    '   • Academic Progression: Students must clear all registered courses in a given semester in the first attempt, having backlogs can lead to the discontinuation of the Merit scholarship from the subsequent Academic year.'
  ]

  instructions.forEach(text => {
    const startX = 50 + boxPadding;
    const fullWidth = 495 - (boxPadding * 2);
    let bullet = '';
    let content = text;
    let indent = 0;
    
    // Check for Main Point (e.g. "1. ")
    const mainMatch = text.match(/^(\d+\.)\s+(.*)/);
    // Check for Sub Point (e.g. "   • ")
    const subMatch = text.match(/^\s+(•)\s+(.*)/);

    const currentY = doc.y;

    if (mainMatch) {
      bullet = mainMatch[1];
      content = mainMatch[2];
      indent = 15;
      
      doc.text(bullet, startX, currentY); // Draw Bullet
      doc.text(content, startX + indent, currentY, { width: fullWidth - indent, align: 'left', lineGap: 1 }); // Draw Text with Indent
    } else if (subMatch) {
      bullet = '•'; 
      content = subMatch[2];
      indent = 30; // Indent further
      
      doc.text(bullet, startX + 15, currentY); // Draw Bullet Indented
      doc.text(content, startX + indent, currentY, { width: fullWidth - indent, align: 'left', lineGap: 1 });
    } else {
      // Fallback for lines without bullets (e.g. continuations if any, though not expected in current data)
      // Or "   Such requests..."
      if (text.trim().startsWith('Such requests')) {
         indent = 15;
         doc.text(text.trim(), startX + indent, doc.y, { width: fullWidth - indent, align: 'left', lineGap: 1 });
      } else {
         doc.text(text, startX, doc.y, { width: fullWidth, align: 'left', lineGap: 1 });
      }
    }
    
    doc.y += 3;
  });
  
  const endY = doc.y + boxPadding;
  
  // Draw Box
  doc.rect(50, startY, 495, endY - startY).strokeColor('#000000').stroke();
  
  doc.y = endY + 10;
}

/* ================= BIG WATERMARK ================= */

function drawBigWatermark(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/logo.png')
  if (!fs.existsSync(logoPath)) return

  doc.save()
  doc.opacity(0.05)

  const size = 320
  const x = doc.page.width / 2 - size / 2
  const y = doc.page.height / 2 - size / 2

  doc.image(logoPath, x, y, { width: size })
  doc.restore()
}
