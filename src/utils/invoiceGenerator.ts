import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { format } from 'date-fns'

export interface InvoiceData {
  invoiceNumber: string
  date: Date
  studentName: string
  studentId: string
  paymentMethod: string
  transactionId: string
  amount: number
  description: string

  signerName: string          // ⭐ Dynamic signer name
  signerTitle: string         // e.g. "Chancellor" / "Principal"
  signedDate?: Date           // ⭐ Date under signature (optional)

  address: {
    line1: string
    city: string
    state: string
    pincode: string
  }
}

export const generateInvoicePDF = async (data: InvoiceData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const buffers: Buffer[] = []

      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', reject)

      drawWatermark(doc)                 // ⭐ watermark behind everything
      drawCollegeHeader(doc)
      drawInvoiceTitle(doc)
      drawStudentAndInvoiceInfo(doc, data)
      drawTable(doc, data)
      drawSignatureAndStamp(doc, data)   // ⭐ dynamic signer + date
      drawFooter(doc)

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ================= WATERMARK ================= */

function drawWatermark(doc: PDFKit.PDFDocument) {
  const stampPath = path.join(process.cwd(), 'src/assets/college-stamp.png')

  if (!fs.existsSync(stampPath)) return

  doc.save()
  doc.opacity(0.08) // ⭐ watermark transparency

  doc.image(stampPath, 150, 280, {
    width: 300,
  })

  doc.restore()
}

/* ================= COLLEGE HEADER ================= */

function drawCollegeHeader(doc: PDFKit.PDFDocument) {
  const logoPath = path.join(process.cwd(), 'src/assets/CollegeLogo.png')

  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 50, 40, { width: 60 })
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#000')
    .text('VVIT University', 130, 45)

  doc
    .font('Helvetica')
    .fontSize(11)
    .text('', 130, 70)

  doc
    .fontSize(10)
    .fillColor('#333')
    .text(
      'Nambur, Guntur, Andhra Pradesh - 522508',
      350,
      50,
      { align: 'right' }
    )
    .text('support@vvitedu.in', 350, 65, { align: 'right' })

  drawLine(doc, 125)
}

/* ================= INVOICE TITLE ================= */

function drawInvoiceTitle(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .text('INVOICE', 50, 145)

  drawLine(doc, 175)
}

/* ================= BILLED TO + INVOICE DETAILS ================= */

function drawStudentAndInvoiceInfo(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const top = 195
  const leftX = 50
  const rightX = 330

  doc.font('Helvetica-Bold').fontSize(11).text('Billed To:', leftX, top)
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(data.studentName, leftX, top + 18)
    .text(`Student ID: ${data.studentId}`, leftX, top + 33)
    .text(data.address.line1, leftX, top + 48)
    .text(
      `${data.address.city}, ${data.address.state} - ${data.address.pincode}`,
      leftX,
      top + 63,
      { width: 250 }
    )

  doc.font('Helvetica-Bold').fontSize(11).text('Invoice Details:', rightX, top)
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(`Invoice No: ${data.invoiceNumber}`, rightX, top + 18)
    .text(`Date: ${format(data.date, 'dd/MM/yyyy')}`, rightX, top + 33)
    .text('Transaction ID:', rightX, top + 48)
    .text(data.transactionId, rightX, top + 63, { width: 200 })
    .text(`Payment Method: ${data.paymentMethod}`, rightX, top + 78)

  drawLine(doc, top + 115)
}

/* ================= TABLE ================= */

function drawTable(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const tableTop = 345

  doc.font('Helvetica-Bold').fontSize(11)
  drawTableRow(doc, tableTop, 'S.No', 'Description', 'Amount (INR)')
  drawLine(doc, tableTop + 20)

  doc.font('Helvetica').fontSize(10)
  drawTableRow(
    doc,
    tableTop + 35,
    '1',
    data.description,
    data.amount.toFixed(2)
  )

  drawLine(doc, tableTop + 60)

  doc.font('Helvetica-Bold')
  doc.text('Total', 350, tableTop + 80)
  doc.text(`₹ ${data.amount.toFixed(2)}`, 0, tableTop + 80, {
    align: 'right',
  })

  doc
    .fontSize(16)
    .fillColor('#2ecc71')
    .text('PAID', 0, tableTop + 120, { align: 'center' })
}

/* ================= SIGNATURE (DYNAMIC) ================= */

function drawSignatureAndStamp(
  doc: PDFKit.PDFDocument,
  data: InvoiceData
) {
  const signPath = path.join(process.cwd(), 'src/assets/chancellor-sign.png')
  const y = 560

  if (fs.existsSync(signPath)) {
    doc.image(signPath, 70, y, { width: 120 })
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(data.signerName, 70, y + 55)

  doc
    .font('Helvetica')
    .fontSize(9)
    .text(data.signerTitle, 70, y + 70)
    .text(
      `Date: ${format(data.signedDate ?? data.date, 'dd/MM/yyyy')}`,
      70,
      y + 85
    )
}

/* ================= FOOTER ================= */

function drawFooter(doc: PDFKit.PDFDocument) {
  drawLine(doc, 720)

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555')
    .text(
      'This is a system generated invoice and does not require a physical signature.',
      50,
      735,
      { align: 'center', width: 500 }
    )
}

/* ================= HELPERS ================= */

function drawTableRow(
  doc: PDFKit.PDFDocument,
  y: number,
  col1: string,
  col2: string,
  col3: string
) {
  doc.text(col1, 50, y, { width: 50 })
  doc.text(col2, 110, y, { width: 250 })
  doc.text(col3, 0, y, { align: 'right' })
}

function drawLine(doc: PDFKit.PDFDocument, y: number) {
  doc
    .strokeColor('#ccc')
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(550, y)
    .stroke()
}
