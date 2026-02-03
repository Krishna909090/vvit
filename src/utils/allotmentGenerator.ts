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

      drawHeader(doc)
      drawBigWatermark(doc)

      if (data.profilePhotoUrl) {
        await drawProfilePhoto(doc, data.profilePhotoUrl)
      }

      drawTitle(doc)
      drawMainTable(doc, data)
      drawUniversityInstructions(doc)
      // drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ================= HEADER ================= */

function drawHeader(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/logo.png')

  // 3. LOGO (Row 2, Bigger, Beside Address) - Moved Down as requested
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 30, 70, { width: 70 })
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
      { width: doc.page.width, align: 'center', lineBreak: false } 
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
  
  doc.y = 85 
}

/* ================= TITLE ================= */

function drawTitle(doc: PDFKit.PDFDocument) {
  // Ensure perfectly centered
  doc
    .font('Helvetica-Bold')
    .fontSize(16) 
    .fillColor('#1C2833')
    .text('PROVISIONAL ALLOTMENT ORDER', 0, doc.y, { align: 'center', width: doc.page.width })

  doc
    .moveDown(0.3)
    .fontSize(10)
    .fillColor('#566573')
    .text('(Academic Year 2025–2026)', { align: 'center', width: doc.page.width })

  // Adjusted spacing
  doc.moveDown(1.0) 
}

/* ================= MAIN TABLE ================= */

function drawMainTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
  const startY = Math.max(doc.y, 135) // Ensure clearing header logo/photo (ends approx 140)
  const col1X = 40
  const col2X = 190 // Increased Col 1 Width (40 to 190 = 150 width)
  const col3X = 330 // Shifted Col 3 to maintain balance (Col 2: 190 to 330 = 140 width)
  const col4X = 410 // Shifted Col 4 (Col 3: 330 to 410 = 80 width. Label "App ID" fits?)
  const width = 515
  const rowHeight = 28 // Reduced Row Height (Compact)
  const rowCount = 8 

  doc.strokeColor('#D5D8DC')
  doc.rect(40, startY, width, rowHeight * rowCount).stroke()

  for (let i = 1; i < rowCount; i++) {
    doc
      .moveTo(40, startY + rowHeight * i)
      .lineTo(555, startY + rowHeight * i)
      .stroke()
  }

  // Vertical Lines - Main Column Separator
  doc.moveTo(col2X, startY).lineTo(col2X, startY + rowHeight * rowCount).stroke()
  
  // Vertical Lines - 3rd/4th Columns (Split for Details) - Top Block Only (Rows 1-3)
  doc.moveTo(col3X, startY).lineTo(col3X, startY + rowHeight * 3).stroke()
  doc.moveTo(col4X, startY).lineTo(col4X, startY + rowHeight * 3).stroke()
  
  // NOTE: No vertical lines for Bottom Block (Rows 5-7) to allow full width for Tuition details

  const paddingY = 9 // Reduced padding for smaller row height

  // Row 1
  drawCell(doc, 'Candidate Name', col1X, startY, paddingY, true)
  drawCell(doc, data.studentName, col2X, startY, paddingY, false)
  drawCell(doc, 'Application ID', col3X, startY, paddingY, true)
  drawCell(doc, data.applicationId, col4X, startY, paddingY, false)

  // Row 2
  drawCell(doc, 'Father Name', col1X, startY + rowHeight, paddingY, true)
  drawCell(doc, data.fatherName, col2X, startY + rowHeight, paddingY, false)
  drawCell(doc, 'Gender', col3X, startY + rowHeight, paddingY, true)
  drawCell(doc, data.gender, col4X, startY + rowHeight, paddingY, false)

  // Row 3
  drawCell(doc, 'Mother Name', col1X, startY + rowHeight * 2, paddingY, true)
  drawCell(doc, data.motherName, col2X, startY + rowHeight * 2, paddingY, false)
  drawCell(doc, 'State', col3X, startY + rowHeight * 2, paddingY, true)
  drawCell(doc, data.state, col4X, startY + rowHeight * 2, paddingY, false)

  // Row 4: Allotted Course (Spans across)
  drawCell(doc, 'Allotted Course', col1X, startY + rowHeight * 3, paddingY, true)
  doc.text(
    data.allottedCourse,
    col2X + 5,
    startY + rowHeight * 3 + paddingY,
    { width: 350 }
  )

  // Row 5: Actual Tuition Fee
  drawCell(doc, 'Actual Tuition fee', col1X, startY + rowHeight * 4, paddingY, true)
  drawCell(doc, `INR ${(data.tuitionFee || 0).toLocaleString('en-IN')}`, col2X, startY + rowHeight * 4, paddingY, false)

  // Row 6: Scholarship Applied
  drawCell(doc, 'Scholarship applied', col1X, startY + rowHeight * 5, paddingY, true)
  const scholarshipText = `INR ${(data.scholarshipDiscount || 0).toLocaleString('en-IN')} (${data.scholarshipPercentage || 0}%)`
  drawCell(doc, scholarshipText, col2X, startY + rowHeight * 5, paddingY, false)

  // Row 7: Tuition Fee Payable per Year
  const payable = (data.tuitionFee || 0) - (data.scholarshipDiscount || 0)
  drawCell(doc, 'Tuition fee payable per year', col1X, startY + rowHeight * 6, paddingY, true)
  drawCell(doc, `INR ${payable.toLocaleString('en-IN')}`, col2X, startY + rowHeight * 6, paddingY, false)


  // Row 8: Total Pending
  doc.roundedRect(40, startY + rowHeight * 7, width, rowHeight, 6).fill('#FEF5E7')

  doc
    .font('Helvetica-Bold')
    .fontSize(10) // Match cell font size
    .fillColor('#7D6608')
    .text('Total Pending Fee', col1X + 5, startY + rowHeight * 7 + paddingY)

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#000000') 
    .text(
      `INR ${data.totalPending?.toLocaleString('en-IN') || '0'}`,
      col2X + 5,
      startY + rowHeight * 7 + paddingY,
      { width: 350 }
    )

  doc.y = startY + rowHeight * rowCount + 15
}

/* ================= PROFILE PHOTO ================= */

async function drawProfilePhoto(doc: PDFKit.PDFDocument, url: string) {
  try {
    const photoBuffer = await fetchImage(url)
    if (photoBuffer) {
      // Position: Top Right
      const photoSize = 55;
      const x = doc.page.width - 40 - photoSize; 
      const y = 60; // Position Y=70
      
      doc.save()
      doc.image(photoBuffer, x, y, { fit: [photoSize, photoSize] })
      doc.rect(x, y, photoSize, photoSize).stroke()
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
    .fontSize(9) // Smaller Font
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
  const contentStartY = startY + boxPadding;
  
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#2E4053')
    .text('Important Conditions of Provisional Admission', 40 + boxPadding, contentStartY, { underline: true })

  doc.moveDown(0.8)

  doc.font('Helvetica').fontSize(8).fillColor('#000')

  const instructions = [
    '1. Provisional Nature of Admission: The admission offered through this letter is purely provisional in nature and is subject to fulfilment of all eligibility requirements as prescribed by VVIT University and statutory authorities.',
    '2. Confirmation of Admission: Confirmation of admission shall be strictly subject to:',
    '   o Submission of all original documents as specified in the separate annexures applicable for UG and PG programmes, and',
    '   o Payment of all applicable fee components, including but not limited to Tuition Fee, Hostel Fee and/or Transportation Fee, within the stipulated time.',
    '3. Change of Branch / Programme: Any request for change of branch or change of programme shall be considered solely at the discretion of the Director – Admissions, subject to availability of seats and eligibility criteria.',
    '   Such requests must be submitted through:',
    '   o Official Email: admissions@vvitu.ac.in',
    '   o Handwritten letter submitted to Director Admissions.',
    '4. Merit Scholarship Condition: Students who are awarded a Merit Scholarship are required to pay the complete applicable fee components on or before the Official Reporting Day, which will be notified separately by the University. Adjustment of scholarship benefits, if any, shall be governed by the University norms.',
    '5. Continuation of Merit Scholarship after 1st year:',
    '   o Attendance, Conduct and Discipline: Candidate must maintain 75% attendance in each Semester and have no history of major disciplinary violations or "code of conduct" breaches.',
    '   o Academic Progression: Students must clear all registered courses in a given semester in the first attempt, having backlogs can lead to the discontinuation of the Merit scholarship from the subsequent Academic year.'
  ]

  instructions.forEach(text => {
    // Indent text inside box
    doc.text(text, 40 + boxPadding, doc.y, { width: 515 - (boxPadding * 2), align: 'left', lineGap: 2 })
    doc.moveDown(0.2)
  });
  
  const endY = doc.y + boxPadding;
  
  // Draw Box
  doc.rect(40, startY, 515, endY - startY).strokeColor('#000000').stroke();
  
  doc.y = endY + 10;
}

/* ================= FOOTER ================= */

// function drawFooter(doc: PDFKit.PDFDocument) {
//   doc
//     .fontSize(9)
//     .fillColor('#7B7D7D')
//     .text(
//       'This is a system-generated provisional allotment order. Signature not required.',
//       40,
//       doc.page.height - 60,
//       { width: 515, align: 'center' }
//     )
// }
