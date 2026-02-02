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

      drawHeader(doc)
      drawBigWatermark(doc)

      if (data.profilePhotoUrl) {
        await drawProfilePhoto(doc, data.profilePhotoUrl)
      }

      drawTitle(doc)
      drawMainTable(doc, data)
      drawUniversityInstructions(doc)
      drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ================= HEADER ================= */

function drawHeader(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png')

  // 3. LOGO (Row 2, Bigger, Beside Address) - Moved Down
  if (fs.existsSync(logoPath)) {
     // Moved down from 25 to 45
    doc.image(logoPath, 30, 45, { width: 70 })
  }

  // 1. COLLEGE NAME (Centered, Single Line)
  doc
    .font('Helvetica-Bold')
    .fontSize(14) 
    .fillColor('#000000')
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      0, // Left 0
      30, // Y
      { width: doc.page.width, align: 'center', lineBreak: false } // Full width center
    )

  // 2. ADDRESS (Centered, Single Line)
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#000000')
    .text(
      'Uppalapadu Road, Nambur, Pedhakakani Mandal, Guntur, Andhra Pradesh – 522508',
      0, 
      50, 
      { width: doc.page.width, align: 'center', lineBreak: false }
    )

  // Move Title Up: Was 110, now 85
  doc.y = 85 
}

/* ================= TITLE ================= */

function drawTitle(doc: PDFKit.PDFDocument) {
  // Ensure perfectly centered
  doc
    .font('Helvetica-Bold')
    .fontSize(16) // Slightly smaller strictly to ensure single line if needed? 18 fine.
    .fillColor('#1C2833')
    .text('PROVISIONAL ALLOTMENT ORDER', 0, doc.y, { align: 'center', width: doc.page.width })

  doc
    .moveDown(0.3)
    .fontSize(10)
    .fillColor('#566573')
    .text('(Academic Year 2025–2026)', { align: 'center', width: doc.page.width })

  doc.moveDown(1.2)
}

/* ================= MAIN TABLE ================= */

function drawMainTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
  const startY = doc.y
  const col1X = 40
  const col2X = 140
  const col3X = 310
  const col4X = 400
  const width = 515
  const rowHeight = 35
  const rowCount = 5

  doc.strokeColor('#D5D8DC')
  doc.rect(40, startY, width, rowHeight * rowCount).stroke()

  for (let i = 1; i < rowCount; i++) {
    doc
      .moveTo(40, startY + rowHeight * i)
      .lineTo(555, startY + rowHeight * i)
      .stroke()
  }

  doc.moveTo(col2X, startY).lineTo(col2X, startY + rowHeight * rowCount).stroke()
  doc.moveTo(col3X, startY).lineTo(col3X, startY + rowHeight * 3).stroke()
  doc.moveTo(col4X, startY).lineTo(col4X, startY + rowHeight * 3).stroke()

  const paddingY = 12

  drawCell(doc, 'Candidate Name', col1X, startY, paddingY, true)
  drawCell(doc, data.studentName, col2X, startY, paddingY, false)
  drawCell(doc, 'Application ID', col3X, startY, paddingY, true)
  drawCell(doc, data.applicationId, col4X, startY, paddingY, false)

  drawCell(doc, 'Father Name', col1X, startY + rowHeight, paddingY, true)
  drawCell(doc, data.fatherName, col2X, startY + rowHeight, paddingY, false)
  drawCell(doc, 'Gender', col3X, startY + rowHeight, paddingY, true)
  drawCell(doc, data.gender, col4X, startY + rowHeight, paddingY, false)

  drawCell(doc, 'Mother Name', col1X, startY + rowHeight * 2, paddingY, true)
  drawCell(doc, data.motherName, col2X, startY + rowHeight * 2, paddingY, false)
  drawCell(doc, 'State', col3X, startY + rowHeight * 2, paddingY, true)
  drawCell(doc, data.state, col4X, startY + rowHeight * 2, paddingY, false)

  drawCell(doc, 'Allotted Course', col1X, startY + rowHeight * 3, paddingY, true)
  doc.text(
    data.allottedCourse,
    col2X + 5,
    startY + rowHeight * 3 + paddingY,
    { width: 380 }
  )

  doc.roundedRect(40, startY + rowHeight * 4, width, rowHeight, 6).fill('#FEF5E7')

  doc
    .font('Helvetica-Bold')
    .fillColor('#7D6608')
    .text('Total Pending Fee', col1X + 5, startY + rowHeight * 4 + paddingY)

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#000000') // Changed from Red to Black
    .text(
      `INR ${data.totalPending?.toLocaleString('en-IN') || '0'}`,
      col2X + 5,
      startY + rowHeight * 4 + paddingY,
      { width: 380 }
    )

  doc.y = startY + rowHeight * rowCount + 30
}

/* ================= PROFILE PHOTO ================= */

async function drawProfilePhoto(doc: PDFKit.PDFDocument, url: string) {
  try {
    const photoBuffer = await fetchImage(url)
    if (photoBuffer) {
      // Position: Top Right
      const x = doc.page.width - 40 - 90; 
      const y = 30; // Aligned roughly with Name/Logo
      
      doc.save()
      doc.image(photoBuffer, x, y, { fit: [90, 90] })
      doc.rect(x, y, 90, 90).stroke()
      doc.restore()
    }
  } catch (err) {
    console.error("Error drawing profile photo:", err);
  }
}

function drawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  paddingY: number,
  isBold: boolean
) {
  doc
    .font(isBold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(10)
    .fillColor('#000')
    .text(text, x + 5, y + paddingY)
}

/* ================= BIG WATERMARK ================= */

function drawBigWatermark(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png')
  if (!fs.existsSync(logoPath)) return

  doc.save()
  doc.opacity(0.05)

  const size = 320
  const x = doc.page.width / 2 - size / 2
  const y = doc.page.height / 2 - size / 2

  doc.image(logoPath, x, y, { width: size })
  doc.restore()
}

/* ================= UNIVERSITY INSTRUCTIONS ================= */

function drawUniversityInstructions(doc: PDFKit.PDFDocument) {
  const startY = doc.y;
  const boxPadding = 15;
  
  // Calculate height needed (Approximate or measure)
  // We have Title + 4 Instructions with wrapping text.
  // Better approach: Draw everything, then draw rect around it? 
  // PDFKit draws linearly. We need to save Y, draw, get end Y, then draw rect?
  // Or Fixed size/dynamic calculation.
  
  // Let's use a "Group" concept by saving Y.
  const contentStartY = startY + boxPadding;
  
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#2E4053')
    .text('Important Conditions of Provisional Admission', 40 + boxPadding, contentStartY, { underline: true })

  doc.moveDown(0.8)

  doc.font('Helvetica').fontSize(10).fillColor('#000')

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
    // Indent text inside box
    doc.text(text, 40 + boxPadding, doc.y, { width: 515 - (boxPadding * 2), align: 'left', lineGap: 4 })
    doc.moveDown(0.5)
  });
  
  const endY = doc.y + boxPadding;
  
  // Draw Box
  doc.rect(40, startY, 515, endY - startY).strokeColor('#000000').stroke();
  
  doc.y = endY + 10;
}

/* ================= FOOTER ================= */

function drawFooter(doc: PDFKit.PDFDocument) {
  doc
    .fontSize(9)
    .fillColor('#7B7D7D')
    .text(
      'This is a system-generated provisional allotment order. Signature not required.',
      40,
      doc.page.height - 60,
      { width: 515, align: 'center' }
    )
}
