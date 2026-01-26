import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { format } from 'date-fns'

/* ================= INTERFACES ================= */

export interface InvoiceItem {
  description: string
  amount: number
}

export interface InvoiceData {
  invoiceNumber: string
  date: Date
  studentName: string
  studentId: string
  paymentMethod: string
  transactionId: string
  amount: number
  description: string
  items?: InvoiceItem[]
  address: {
    line1: string
    line2?: string
    city: string
    state: string
    pincode: string
  }
}

/* ================= MAIN ================= */

export const generateInvoicePDF = async (
  data: InvoiceData
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 30
      })

      const buffers: Buffer[] = []
      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', reject)

      drawHeader(doc)
      drawInfoGrid(doc, data)
      drawSubjectBar(doc, data)
      drawItemsTable(doc, data)
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

  // University name
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#C0392B')
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      0,
      20,
      { align: 'center', width: doc.page.width }
    )

  // Logo (left)
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 30, 45, { width: 60 })
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#C0392B')
      .text('VVIT', 30, 55)
  }

  // Address (right – unchanged content)
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#555')
    .text(
      'VVIT University, Uppalapadu Road,\nNambur, DT, Pedhakakani Mandal,\nGuntur, Andhra Pradesh – 522508',
      350,
      48,
      { align: 'right' }
    )
}

/* ================= INFO GRID ================= */

function drawInfoGrid(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const top = 95

  doc
    .roundedRect(30, top, 535, 85, 6)
    .strokeColor('#eaeaea')
    .stroke()

  const leftX = 45
  const rightX = 320
  let y = top + 12

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#7f8c8d')
  doc.text('BILLED TO', leftX, y)
  doc.text('INVOICE DETAILS', rightX, y)

  y += 12

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
  doc.text(data.studentName, leftX, y)

  doc.font('Helvetica').fontSize(9).fillColor('#333')
  doc.text(`Student ID: ${data.studentId}`, leftX, y + 12)
  doc.text(
    `${data.address.line1}${data.address.line2 ? ', ' + data.address.line2 : ''}`,
    leftX,
    y + 24
  )
  doc.text(
    `${data.address.city}, ${data.address.state} - ${data.address.pincode}`,
    leftX,
    y + 36
  )

  doc.text(`Invoice No: ${data.invoiceNumber}`, rightX, y)
  doc.text(`Date: ${format(data.date, 'dd/MM/yyyy')}`, rightX, y + 12)
  doc.text(`Txn ID: ${data.transactionId}`, rightX, y + 24)
  doc.text(`Payment: ${data.paymentMethod}`, rightX, y + 36)
}

/* ================= SUBJECT BAR ================= */

function drawSubjectBar(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const y = 195
  const barX = 30
  const barWidth = 535
  const padding = 15

  // Draw background
  doc
    .save()
    .roundedRect(barX, y, barWidth, 32, 6)
    .fill('#f8f9fa')
    .restore()

  // Subject (left)
  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(`Subject: ${data.description}`, barX + padding, y + 10, {
      width: barWidth - 120 // reserve space for amount
    })

  // Amount (RIGHT – SAFE positioning)
  const totalStr = data.amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2
  })

  const textWidth = doc.widthOfString(totalStr)

  doc
    .fontSize(10)
    .text(
      totalStr,
      barX + barWidth - padding - textWidth,
      y + 9
    )
}


/* ================= ITEMS TABLE ================= */

function drawItemsTable(doc: PDFKit.PDFDocument, data: InvoiceData) {
  let y = 240

  drawLine(doc, y)
  y += 6

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#7f8c8d')
  doc.text('S.NO', 45, y)
  doc.text('DESCRIPTION', 90, y)
  doc.text('AMOUNT (INR)', 460, y)

  y += 12
  drawLine(doc, y)
  y += 8

  const items =
    data.items && data.items.length
      ? data.items
      : [{ description: data.description, amount: data.amount }]

  doc.font('Helvetica').fontSize(9).fillColor('#000')

  items.forEach((item, index) => {
    doc.text(String(index + 1), 45, y)
    doc.text(item.description, 90, y, { width: 350 })
    doc.text(
      item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      460,
      y
    )
    y += 18
  })

  drawLine(doc, y + 4)
}

/* ================= FOOTER ================= */

function drawFooter(doc: PDFKit.PDFDocument) {
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#999')
    .text(
      'This is a system generated invoice and does not require a physical signature',
      0,
      380,
      { align: 'center', width: doc.page.width }
    )
}

/* ================= HELPER ================= */

function drawLine(
  doc: PDFKit.PDFDocument,
  y: number,
  startX = 30,
  endX = 565
) {
  doc
    .strokeColor('#eaeaea')
    .lineWidth(1)
    .moveTo(startX, y)
    .lineTo(endX, y)
    .stroke()
}
