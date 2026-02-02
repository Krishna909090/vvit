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
}

/* ================= HELPERS ================= */

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer' })
    return Buffer.from(res.data)
  } catch {
    return null
  }
}

/* ================= MAIN ================= */

/* ================= MAIN ================= */

export const generateAllotmentOrderPDF = async (
  data: AllotmentData
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 })
      const buffers: Buffer[] = []

      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', reject)

      drawHeader(doc)
      drawTitle(doc)
      drawMainTable(doc, data)
      drawBigWatermark(doc)
      drawUniversityInstructions(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ================= HEADER ================= */

/* ================= HEADER ================= */

function drawHeader(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png')

  doc.rect(0, 0, doc.page.width, 95).fill('#F4F6F7')

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 30, 22, { width: 60 })
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#1B2631')
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      100,
      30,
      { width: 480 }
    )

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#34495E')
    .text(
      'Uppalapadu Road, Nambur, DT, Pedhakakani Mandal, Guntur, Andhra Pradesh 522508',
      0,
      55,
      { width: doc.page.width, align: 'center' }
    )

  doc.y = 115
}

/* ================= TITLE ================= */

function drawTitle(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor('#2E4053')
    .text('PROVISIONAL ALLOTMENT ORDER', { align: 'center', underline: true })

  doc.moveDown(1.0)
}

/* ================= MAIN TABLE ================= */

function drawMainTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
  // Title removed as requested

  const startY = doc.y;
  const col1X = 40;
  const col2X = 140; // Value 1 start
  const col3X = 310; // Label 2 start
  const col4X = 400; // Value 2 start
  const width = 515;
  const rowHeight = 35; 
  const rowCount = 5;

  // Draw Table Border
  doc.rect(40, startY, width, rowHeight * rowCount).stroke();

  // Horizontal Lines
  for (let i = 1; i < rowCount; i++) {
    doc.moveTo(40, startY + rowHeight * i).lineTo(555, startY + rowHeight * i).stroke();
  }

  // Vertical Dividers
  
  // 1. First vertical divider (Separates Label1 from Value1) - Runs through ALL rows
  doc.moveTo(col2X, startY).lineTo(col2X, startY + rowHeight * rowCount).stroke();

  // 2. Second & Third vertical dividers (For 4-column structure) - Runs only for first 3 rows
  doc.moveTo(col3X, startY).lineTo(col3X, startY + rowHeight * 3).stroke();
  doc.moveTo(col4X, startY).lineTo(col4X, startY + rowHeight * 3).stroke();


  // Data Contena
  doc.fillColor('#000000');
  const fontSizeLabel = 10;
  const fontSizeValue = 10;
  const paddingY = 12;

  // Row 1
  drawCell(doc, 'Candidate Name', col1X, startY, paddingY, true);
  drawCell(doc, data.studentName, col2X, startY, paddingY, false);
  drawCell(doc, 'Application ID', col3X, startY, paddingY, true);
  drawCell(doc, data.applicationId, col4X, startY, paddingY, false);

  // Row 2
  drawCell(doc, 'Father Name', col1X, startY + rowHeight, paddingY, true);
  drawCell(doc, data.fatherName, col2X, startY + rowHeight, paddingY, false);
  drawCell(doc, 'Gender', col3X, startY + rowHeight, paddingY, true);
  drawCell(doc, data.gender, col4X, startY + rowHeight, paddingY, false);

  // Row 3 (Mother Name | Empty)
  drawCell(doc, 'Mother Name', col1X, startY + rowHeight * 2, paddingY, true);
  drawCell(doc, data.motherName, col2X, startY + rowHeight * 2, paddingY, false);
  drawCell(doc, 'State', col3X, startY + rowHeight * 2, paddingY, true);
  drawCell(doc, data.state, col4X, startY + rowHeight * 2, paddingY, false);

  // Row 4 (Allotted College - Full Span)
  drawCell(doc, 'Allotted Course', col1X, startY + rowHeight * 3, paddingY, true);
  doc.font('Helvetica').fontSize(fontSizeValue).text(data.allottedCourse, col2X + 5, startY + rowHeight * 3 + paddingY, { width: 380 });

  doc.y = startY + rowHeight * rowCount + 30;
}

function drawCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number, paddingY: number, isBold: boolean) {
  doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(text, x + 5, y + paddingY);
}

/* ================= TABLE HELPERS ================= */

function drawTableHeader(doc: PDFKit.PDFDocument, title: string) {
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#1F618D')
    .text(title)
  
  doc.moveDown(0.8);
}

function drawRow(doc: PDFKit.PDFDocument, label: string, value: string) {
  // Deprecated
}

/* ================= BIG WATERMARK ================= */

function drawBigWatermark(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png')
  if (!fs.existsSync(logoPath)) return

  doc.save()
  doc.opacity(0.04)

  const size = 350
  const x = doc.page.width / 2 - size / 2
  const y = doc.page.height / 2 - size / 2

  doc.image(logoPath, x, y, { width: size })
  doc.restore()
}

/* ================= UNIVERSITY INSTRUCTIONS ================= */

function drawUniversityInstructions(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#2E4053')
    .text('Important Conditions of Provisional Admission', 40, doc.y)

  doc.moveDown(0.8)

  doc.font('Helvetica').fontSize(10).fillColor('#000') // Increased Font Size

  const instructions = [
    '1. Provisional Nature of Admission: The admission offered through this letter is purely provisional in nature and is subject to fulfilment of all eligibility requirements as prescribed by VVIT University and statutory authorities.',
    '2. Confirmation of Admission: Confirmation of admission shall be strictly subject to:',
    '   o Submission of all original documents as specified in the separate annexures applicable for UG and PG programmes, and',
    '   o Payment of all applicable fee components, including but not limited to Tuition Fee, Hostel Fee and/or Transportation Fee, within the stipulated time.',
    '3. Change of Branch / Programme: Any request for change of branch or change of programme shall be considered solely at the discretion of the Director – Admissions, subject to availability of seats and eligibility criteria.',
    '   Such requests must be submitted through:',
    '   o Official Email: admissions@vvitu.ac.in',
    '   o Handwritten letter submitted to Director Admissions.',
    '4. Merit Scholarship Condition: Students who are awarded a Merit Scholarship are required to pay the complete applicable fee components on or before the Official Reporting Day, which will be notified separately by the University. Adjustment of scholarship benefits, if any, shall be governed by the University norms.'
  ]

  instructions.forEach(text => {
    doc.text(text, 40, doc.y, { width: 515, align: 'left', lineGap: 4 })
    doc.moveDown(0.5)
  })
}
