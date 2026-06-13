import PDFDocument from 'pdfkit'
import path from 'path'
import axios from 'axios'
import fs from 'fs'

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

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer' })
    return Buffer.from(res.data)
  } catch (error: any) {
    console.error(`Failed to fetch image from ${url}:`, error.message);
    return null
  }
}

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

      drawTitle(doc)

      const detailsEndY = await drawStudentDetailsSection(doc, data);

      doc.y = detailsEndY + 10;
      drawFeeTable(doc, data)

      drawUniversityInstructions(doc)

      drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function drawFooter(doc: PDFKit.PDFDocument) {
  const footerText = 'For any queries please contact admission office contact details: 8341098336, 8179488336, 7702943336.';
  
  doc
    .fontSize(9)
    .font('Helvetica-Bold')
    .fillColor('#000000')
    .text(
      footerText,
      40,
      doc.page.height - 60,
      { width: 515, align: 'center' }
    )
}

function drawHeader(doc: PDFKit.PDFDocument) {
  const startY = 15;
  const logoPath = path.join(process.cwd(), 'src/assets/logo.png')

  if (fs.existsSync(logoPath)) {
    const logoSize = 60;
    const logoX = (doc.page.width - logoSize) / 2;
    doc.image(logoPath, logoX, startY, { width: logoSize })

    doc.y = startY + logoSize + 10;
  } else {
    doc.y = startY;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(16) 
    .fillColor('#E74C3C')
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      0,
      doc.y,
      { width: doc.page.width, align: 'center' } 
    )
  
  doc.moveDown(0.3);

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#000000')
    .text(
      'Uppalapadu Road, Nambur, Pedakakani Mandal, Guntur, Andhra Pradesh – 522508',
      { width: doc.page.width, align: 'center' }
    )

  doc.moveDown(0.5);

  const lineY = doc.y;
  doc.save();
  doc.strokeColor('#BDC3C7').dash(4, { space: 2 }).lineWidth(1)
     .moveTo(40, lineY).lineTo(doc.page.width - 40, lineY).stroke();
  doc.restore();

  doc.moveDown(0.5);
}

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

async function drawStudentDetailsSection(doc: PDFKit.PDFDocument, data: AllotmentData): Promise<number> {
  const startY = doc.y;
  const colLabelX = 60;
  const colValueX = 200;
  const lineHeight = 20;

  const fields = [
    { label: 'Candidate Name', value: data.studentName },
    { label: 'Application ID', value: data.applicationId },
    { label: 'Father Name', value: data.fatherName },
    { label: 'Mother Name', value: data.motherName },
    { label: 'Gender', value: data.gender },
    { label: 'State', value: data.state },
  ];

  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  
  fields.forEach((field, index) => {
    const y = startY + (index * lineHeight);

    doc.text(field.label, colLabelX, y);

    doc.text(':', colValueX - 10, y);

    if (index === 0) doc.font('Helvetica-Bold');
    doc.text(field.value, colValueX, y);
    if (index === 0) doc.font('Helvetica');
  });

  const textEndY = startY + (fields.length * lineHeight);

  if (data.profilePhotoUrl) {
    const photoBuffer = await fetchImage(data.profilePhotoUrl);
    if (photoBuffer) {
        const photoWidth = 100;
        const photoHeight = 120;
        const photoX = 420;
        const photoY = startY;

        doc.save();
        try {
            doc.roundedRect(photoX, photoY, photoWidth, photoHeight, 8).clip();
            doc.image(photoBuffer, photoX, photoY, { fit: [photoWidth, photoHeight] });
        } catch (e) {
            console.error('Error drawing profile photo in allotment order', e);
        } finally {
            doc.restore();
        }

        try {
            doc.roundedRect(photoX, photoY, photoWidth, photoHeight, 8).strokeColor('#000').lineWidth(1).stroke();
        } catch (_) {}

        return Math.max(textEndY, photoY + photoHeight);
    }
  }

  return textEndY;
}

function drawFeeTable(doc: PDFKit.PDFDocument, data: AllotmentData) {
  const startY = doc.y;
  const tableX = 50;
  const tableWidth = 495;

  const rowHeight = 30;
  const col1W = 250; 

  const rows = [
    { label: 'Allotted Branch', value: data.allottedCourse, highlight: false },
    { label: 'Actual Tuition fee', value: `INR ${(data.tuitionFee || 0).toLocaleString('en-IN')}`, highlight: false },
    { label: 'Scholarship Approved', value: `INR ${(data.scholarshipDiscount || 0).toLocaleString('en-IN')} (${data.scholarshipPercentage || 0}%)`, highlight: false },
    { label: 'Tuition fee payable per year', value: `INR ${((data.tuitionFee || 0) - (data.scholarshipDiscount || 0)).toLocaleString('en-IN')}`, highlight: true }
  ];

  doc.font('Helvetica').fontSize(10);

  let currentY = startY;

  rows.forEach((row) => {

    if (row.highlight) {
      doc.rect(tableX, currentY, tableWidth, rowHeight).fill('#FEF5E7');
      doc.fillColor('#000');
    }

    doc.rect(tableX, currentY, tableWidth, rowHeight).strokeColor('#E5E7E9').stroke();

    const textY = currentY + 10;

    doc.font('Helvetica').fillColor('#5D6D7E')
    doc.text(row.label, tableX + 20, textY);

    doc.font('Helvetica-Bold').fillColor('#000000')
    doc.text(row.value, tableX + col1W, textY);

    currentY += rowHeight;
  });

  doc.y = currentY + 10;
}

function drawUniversityInstructions(doc: PDFKit.PDFDocument) {
  const startY = doc.y;

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

    const mainMatch = text.match(/^(\d+\.)\s+(.*)/);

    const subMatch = text.match(/^\s+(•)\s+(.*)/);

    const currentY = doc.y;

    if (mainMatch) {
      bullet = mainMatch[1];
      content = mainMatch[2];
      indent = 15;
      
      doc.text(bullet, startX, currentY);
      doc.text(content, startX + indent, currentY, { width: fullWidth - indent, align: 'left', lineGap: 1 });
    } else if (subMatch) {
      bullet = '•'; 
      content = subMatch[2];
      indent = 30;
      
      doc.text(bullet, startX + 15, currentY);
      doc.text(content, startX + indent, currentY, { width: fullWidth - indent, align: 'left', lineGap: 1 });
    } else {

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

  doc.rect(50, startY, 495, endY - startY).strokeColor('#000000').stroke();
  
  doc.y = endY + 10;
}

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

export interface HostelAllotmentData {
  applicationId: string
  studentName: string
  fatherName: string
  motherName: string
  gender: string
  state: string

  hostelName: string
  hostelType: string
  roomNumber: string
  bedNumber: string
  floor?: number
  sharing: number
  roomType: string
  paymentMode: 'YEARWISE' | 'SEMWISE'
  wardenName?: string

  accommodationPrice: number
  messPrice: number
  laundryPrice: number
  registrationFee: number
  effectiveTotal: number

  profilePhotoUrl?: string
  reportingDate?: string
}

export const generateHostelAllotmentOrderPDF = async (
  data: HostelAllotmentData
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
      drawHostelTitle(doc)

      const detailsEndY = await drawStudentDetailsSection(doc, {
        applicationId: data.applicationId,
        studentName: data.studentName,
        fatherName: data.fatherName,
        motherName: data.motherName,
        gender: data.gender,
        state: data.state,
        allottedCollege: '',
        allottedCourse: '',
        profilePhotoUrl: data.profilePhotoUrl,
      } as AllotmentData)

      doc.y = detailsEndY + 10
      drawHostelDetailsBlock(doc, data)
      drawHostelFeeTable(doc, data)
      drawHostelInstructions(doc)
      drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function drawHostelTitle(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica-Bold').fontSize(14).fillColor('#1C2833')
    .text('HOSTEL ALLOTMENT ORDER', 0, doc.y, { align: 'center', width: doc.page.width, underline: true })

  doc.moveDown(0.3)
    .fontSize(10).fillColor('#566573')
    .text('(Academic Year 2026–2027)', { align: 'center', width: doc.page.width })

  doc.moveDown(0.5)
}

function drawHostelDetailsBlock(doc: PDFKit.PDFDocument, data: HostelAllotmentData) {
  const startY = doc.y
  const tableX = 50
  const tableWidth = 495
  const rowHeight = 26

  const rows = [
    { label: 'Hostel',          value: `${data.hostelName} (${data.hostelType})` },
    { label: 'Room Number',     value: data.roomNumber },
    { label: 'Bed Number',      value: data.bedNumber },
    { label: 'Floor',           value: data.floor !== undefined ? String(data.floor) : '—' },
    { label: 'Sharing / Type',  value: `${data.sharing}-Sharing • ${data.roomType}` },
    { label: 'Payment Mode',    value: data.paymentMode === 'SEMWISE' ? 'Two Instalment (Semwise)' : 'Single Instalment (Yearwise)' },
  ]

  let currentY = startY
  rows.forEach((row) => {
    doc.rect(tableX, currentY, tableWidth, rowHeight).strokeColor('#E5E7E9').stroke()
    const textY = currentY + 8
    doc.font('Helvetica').fontSize(10).fillColor('#5D6D7E').text(row.label, tableX + 15, textY)
    doc.font('Helvetica-Bold').fillColor('#000000').text(row.value, tableX + 200, textY)
    currentY += rowHeight
  })

  doc.y = currentY + 10
}

function drawHostelFeeTable(doc: PDFKit.PDFDocument, data: HostelAllotmentData) {
  const startY = doc.y
  const tableX = 50
  const tableWidth = 495
  const rowHeight = 26

  const fmt = (n: number) => `INR ${(n || 0).toLocaleString('en-IN')}`

  const rows = [
    { label: 'Accommodation', value: fmt(data.accommodationPrice), highlight: false },
    { label: 'Mess',          value: fmt(data.messPrice),          highlight: false },
    { label: 'Laundry',       value: fmt(data.laundryPrice),       highlight: false },
    { label: 'Registration',  value: fmt(data.registrationFee),    highlight: false },
    { label: 'Total Payable', value: fmt(data.effectiveTotal),     highlight: true },
  ]

  let currentY = startY
  rows.forEach((row) => {
    if (row.highlight) {
      doc.rect(tableX, currentY, tableWidth, rowHeight).fill('#FEF5E7')
      doc.fillColor('#000000')
    }
    doc.rect(tableX, currentY, tableWidth, rowHeight).strokeColor('#E5E7E9').stroke()
    const textY = currentY + 8
    doc.font('Helvetica').fontSize(10).fillColor('#5D6D7E').text(row.label, tableX + 15, textY)
    doc.font('Helvetica-Bold').fillColor('#000000').text(row.value, tableX + 280, textY)
    currentY += rowHeight
  })

  doc.y = currentY + 10
}

function drawHostelInstructions(doc: PDFKit.PDFDocument) {
  const startY = doc.y
  const boxPadding = 10
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
    .text('Important Conditions of Hostel Allotment', 50 + boxPadding, startY + boxPadding, { underline: true })

  doc.moveDown(0.5)
  doc.font('Helvetica').fontSize(8).fillColor('#000')

  const items = [
    '1. The allotted bed is for the student named above only. Sub-letting or swapping with another student without written approval is strictly prohibited.',
    '2. Hostel fees shown above are payable per the chosen payment mode. Late payment may incur penalties as per university norms.',
    '3. Re-assignment to a different hostel/room/bed is allowed only on written request and at the discretion of the Hostel Warden / Director — Admissions.',
    '4. Damage to hostel property will be billed to the student. Deposits (if applicable) may be withheld for outstanding charges.',
    '5. Students must comply with the Hostel Code of Conduct, including curfew timings, attendance during inspections, and visitor policies.',
    '6. Vacating the hostel mid-year requires approval and may result in pro-rated refunds as per the cancellation policy.',
  ]

  items.forEach((text) => {
    const startX = 50 + boxPadding
    const fullWidth = 495 - (boxPadding * 2)
    const mainMatch = text.match(/^(\d+\.)\s+(.*)/)
    const currentY = doc.y
    if (mainMatch) {
      doc.text(mainMatch[1], startX, currentY)
      doc.text(mainMatch[2], startX + 15, currentY, { width: fullWidth - 15, align: 'left', lineGap: 1 })
    } else {
      doc.text(text, startX, currentY, { width: fullWidth, align: 'left', lineGap: 1 })
    }
    doc.y += 3
  })

  const endY = doc.y + boxPadding
  doc.rect(50, startY, 495, endY - startY).strokeColor('#000000').stroke()
  doc.y = endY + 10
}
