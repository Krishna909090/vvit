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
  receiptNumber?: string
  invoiceNumber: string
  date: Date
  studentName: string
  studentId: string
  paymentMethod: string
  transactionId: string
  referenceId?: string
  amount: number
  description: string
  items?: InvoiceItem[]
  hideTxnId?: boolean
  isCancellation?: boolean
  reason?: string
  academicYear?: string
  courseName?: string
  counterName?: string
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

      // Top Half - Student Copy
      drawInvoiceInstance(doc, data, 0, 'STUDENT COPY')

      // Cut Line (Dashed)
      const midY = 421;
      doc
         .strokeColor('#ccc')
         .dash(5, { space: 5 })
         .moveTo(0, midY)
         .lineTo(595, midY)
         .stroke();
      
      doc.undash(); // Reset dash
      
      // Bottom Half - Office Copy
      drawInvoiceInstance(doc, data, 421, 'OFFICE COPY')

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ================= DRAWING LOGIC ================= */

function drawInvoiceInstance(doc: PDFKit.PDFDocument, data: InvoiceData, offsetY: number, copyLabel: string) {
    drawHeader(doc, offsetY)
    drawWatermark(doc, copyLabel, offsetY)
    drawInfoGrid(doc, data, offsetY)
    const subjectBarHeight = drawSubjectBar(doc, data, offsetY)
    drawItemsTable(doc, data, offsetY, subjectBarHeight)
    drawFooter(doc, offsetY, data)
}

function drawWatermark(doc: PDFKit.PDFDocument, label: string, offsetY: number) {
    doc.save()
    doc.font('Helvetica-Bold')
       .fontSize(10)
       .fillColor('#e74c3c')
       .text(label, 0, offsetY + 70, {
           align: 'center',
           width: doc.page.width
       })
    doc.restore()
}

/* ================= HEADER ================= */

function drawHeader(doc: PDFKit.PDFDocument, topY: number) {
  const logoPath = path.join(process.cwd(), 'src/assets/logo.png')

  // University name
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#C0392B')
    .text(
      'VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
      0,
      topY + 20,
      { align: 'center', width: doc.page.width }
    )

  // Logo (left)
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 30, topY + 45, { width: 60 })
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#C0392B')
      .text('VVIT', 30, topY + 55)
  }

  // Address (right – unchanged content)
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#555')
    .text(
      'VVIT University, Uppalapadu Road,\nNambur, DT, Pedakakani Mandal,\nGuntur, Andhra Pradesh – 522508',
      350,
      topY + 48,
      { align: 'right' }
    )
}

/* ================= INFO GRID ================= */

function drawInfoGrid(doc: PDFKit.PDFDocument, data: InvoiceData, offsetY: number) {
  const top = offsetY + 95

  const hasReceipt = !!(data as any).receiptNumber;
  const boxHeight = (data.academicYear ? 97 : 85) + (hasReceipt ? 12 : 0);
  doc
    .roundedRect(30, top, 535, boxHeight, 6)
    .strokeColor('#eaeaea')
    .stroke()

  const leftX = 45
  const rightX = 320
  let y = top + 12

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#7f8c8d')
  doc.text('BILLED TO', leftX, y)
  doc.text(data.isCancellation ? 'DETAILS' : 'INVOICE DETAILS', rightX, y)

  y += 12

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
  doc.text(data.studentName, leftX, y)

  doc.font('Helvetica').fontSize(9).fillColor('#333')
  doc.text(`Student ID: ${data.studentId}`, leftX, y + 12)

  if (data.isCancellation) {
    doc.text(`Date: ${format(data.date, 'dd/MM/yyyy')}`, rightX, y)
    doc.text(`Reason: ${data.reason ?? ''}`, rightX, y + 12)
  } else {
    if (data.academicYear) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#333')
      doc.text(data.academicYear, rightX, y)
      doc.font('Helvetica').fontSize(9).fillColor('#333')
    }
    const ayOffset = data.academicYear ? 12 : 0;
    let detailY = y + ayOffset;
    if (data.receiptNumber) {
      doc.text(`Receipt No: ${data.receiptNumber}`, rightX, detailY)
      detailY += 12;
    }
    doc.text(`Invoice No: ${data.invoiceNumber}`, rightX, detailY)
    doc.text(`Date: ${format(data.date, 'dd/MM/yyyy')}`, rightX, detailY + 12)

    const utrOffset = (detailY - y) + 24
    const payOffset = (detailY - y) + 36
    const utrDisplay = (data.referenceId && data.referenceId !== data.transactionId) ? data.referenceId : 'N/A';
    doc.text(`UTR: ${utrDisplay}`, rightX, y + utrOffset)

    doc.text(`Payment: ${data.paymentMethod}`, rightX, y + payOffset)
  }
}

/* ================= SUBJECT BAR ================= */

function drawSubjectBar(doc: PDFKit.PDFDocument, data: InvoiceData, offsetY: number) {
  const hasCourse = !!data.courseName
  const barHeight = hasCourse ? 44 : 32
  const y = offsetY + 195
  const barX = 30
  const barWidth = 535
  const padding = 15

  // Draw background
  doc
    .save()
    .roundedRect(barX, y, barWidth, barHeight, 6)
    .fill('#f8f9fa')
    .restore()

  let textY = y + 8

  // Course Name (above subject)
  if (hasCourse) {
    doc
      .fillColor('#333')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(`Course: ${data.courseName}`, barX + padding, textY, {
        width: barWidth - 120
      })
    textY += 14
  }

  // Subject (left)
  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(`Subject: ${data.description}`, barX + padding, textY, {
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
      y + barHeight / 2 - 5
    )

  return barHeight
}


/* ================= ITEMS TABLE ================= */

function drawItemsTable(doc: PDFKit.PDFDocument, data: InvoiceData, offsetY: number, subjectBarHeight: number) {
  let y = offsetY + 195 + subjectBarHeight + 13

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
  y += 8

  // TOTAL Row
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('TOTAL', 90, y)
  doc.text(
    data.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    460,
    y
  )
}

/* ================= FOOTER ================= */

function drawFooter(doc: PDFKit.PDFDocument, offsetY: number, data?: InvoiceData) {
  if (data?.counterName) {
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#333')
      .text(
        `Counter: ${data.counterName}`,
        0,
        offsetY + 365,
        { align: 'center', width: doc.page.width }
      )
  }

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#999')
    .text(
      'This is a system generated invoice and does not require a physical signature',
      0,
      offsetY + 380,
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
