import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { format } from 'date-fns'

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
  description: string // Fallback or main subject
  
  items?: InvoiceItem[] // New Support for multiple items

  signerName?: string          
  signerTitle?: string         
  signedDate?: Date           

  address: {
    line1: string
    line2?: string
    city: string
    state: string
    pincode: string
  }
}

export const generateInvoicePDF = async (data: InvoiceData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 }) // Reduced margin slightly
      const buffers: Buffer[] = []

      doc.on('data', buffers.push.bind(buffers))
      doc.on('end', () => resolve(Buffer.concat(buffers)))
      doc.on('error', reject)

      // Background Color (simulated by a large rectangle, optional, but paper is usually white)
      // doc.rect(0, 0, doc.page.width, doc.page.height).fill('#f8f9fa'); 

      // 1. Header Section
      drawHeader(doc)

      // 2. Info Grid (Billed To / Invoice Details)
      // We wrap this in a rounded rectangle container style if desired, or just whitespace
      drawInfoGrid(doc, data)

      // 3. Subject & Big Total Bar
      drawSubjectAndTotalBar(doc, data)

      // 4. Items Table
      drawItemsTable(doc, data)

      // 5. Footer
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

  // Logo (Left)
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 40, 30, { width: 80 })
  } else {
    // Fallback if logo missing
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#C0392B') // Red color like VVIT
      .text('VVIT', 40, 40)
      .fontSize(10)
      .text('UNIVERSITY', 40, 65)
  }

  // Address (Right)
  const rightX = 350
  const topY = 40

  doc.font('Helvetica').fontSize(9).fillColor('#555555')

  doc.text('Business address', rightX, topY, { align: 'right' })
  doc.text('City, State, IN - 000 000', rightX, topY + 14, { align: 'right' })
  doc.text('TAX ID 00XXXX1234X0XX', rightX, topY + 28, { align: 'right' })
}

/* ================= INFO GRID ================= */
function drawInfoGrid(doc: PDFKit.PDFDocument, data: InvoiceData) {
  // Container Box (Rounded) - Optional, mimicking the "card" look
  const containerTop = 110
  const containerHeight = 150
  const containerWidth = 515
  
  // Draw card border/bg
  doc
    .roundedRect(40, containerTop, containerWidth, 135, 8) 
    .strokeColor('#f0f0f0')
    .lineWidth(1)
    .stroke()

  const startY = containerTop + 20
  const leftColX = 60
  const rightColX = 320

  // ... (content omitted for brevity in thought process, but included in tool call) ...
  // Since I can't selectively replace multiple disconnected chunks easily in one ReplaceFileContent without context, 
  // I will just locate the specific lines to change Y positions.

// Actually, ReplaceFileContent works best on a single block. 
// I will target the InfoGrid function first to fix the rect height.


  // --- Left Column: Billed To ---
  // Ensure font is set before text
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#7f8c8d')
  doc.text('Billed To:', leftColX, startY)
  
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333')
  doc.text(data.studentName, leftColX, startY + 20)

  doc.font('Helvetica').fontSize(10).fillColor('#555555')
  doc.text(`Student ID: ${data.studentId}`, leftColX, startY + 35)
  doc.text(data.address.line1, leftColX, startY + 50)
  
  // Handle optional address line 2 if present
  let cityStateY = startY + 65
  if(data.address.line2) {
      doc.text(data.address.line2, leftColX, cityStateY)
      cityStateY += 15
  }

  const addrCheck = [data.address.city, data.address.state, data.address.pincode].filter(Boolean).join(', ')
  doc.text(addrCheck, leftColX, cityStateY)

  // --- Right Column: Invoice Details ---
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#7f8c8d')
  doc.text('Invoice Details:', rightColX, startY)
  
  const rightLabelX = rightColX
  const rightValueX = rightColX + 90
  const rowH = 15
  let currentY = startY + 20

  // Invoice No
  doc.font('Helvetica').fillColor('#555555').text('Invoice No', rightLabelX, currentY)
  doc.text(': ' + data.invoiceNumber, rightValueX, currentY)
  currentY += rowH

  // Date
  doc.text('Date', rightLabelX, currentY)
  doc.text(': ' + format(data.date, 'dd/MM/yyyy'), rightValueX, currentY)
  currentY += rowH

  // Transaction ID
  doc.text('Transaction ID', rightLabelX, currentY)
  // Ensure long transaction IDs do not wrap uglily, though usually they fit
  doc.text(': ' + data.transactionId, rightValueX, currentY)
  currentY += rowH

  // Payment Method
  doc.text('Payment Method', rightLabelX, currentY)
  doc.text(': ' + data.paymentMethod, rightValueX, currentY)
}

/* ================= SUBJECT & TOTAL BAR ================= */
function drawSubjectAndTotalBar(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const y = 275 // Increased spacing below Info Grid
  const subjectX = 60
  const dateX = 320

  // Subject Label
  doc.font('Helvetica').fontSize(9).fillColor('#7f8c8d')
  doc.text('Subject', subjectX, y)
  // Subject Value
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
  doc.text(data.description, subjectX, y + 15)

  // Invoice Date Label
  doc.font('Helvetica').fontSize(9).fillColor('#7f8c8d')
  doc.text('Invoice date', 40, y, { align: 'right', width: 515 })
  // Invoice Date Value
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
  doc.text(format(data.date, 'dd MMM, yyyy'), 40, y + 15, { align: 'right', width: 515 })


}

/* ================= TABLE ================= */
function drawItemsTable(doc: PDFKit.PDFDocument, data: InvoiceData) {
  const tableTop = 340
  
  // Header Row Line (Top)
  drawLine(doc, tableTop)
  
  // Header Text
  const sNoX = 60
  const descX = 160 // Moved right a bit for spacing
  const amtX = 545 // Right aligned anchor

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#95a5a6')
  doc.text('S.NO', sNoX, tableTop + 8)
  doc.text('DESCRIPTION', descX, tableTop + 8)
  
  const amtLabel = "AMOUNT (INR)"
  doc.text(amtLabel, amtX - doc.widthOfString(amtLabel), tableTop + 8)

  // Header Row Line (Bottom)
  drawLine(doc, tableTop + 25)

  // Items
  let y = tableTop + 40
  const items = data.items && data.items.length > 0 
                ? data.items 
                : [{ description: data.description, amount: data.amount }] // Fallback

  doc.font('Helvetica').fontSize(10).fillColor('#2c3e50') // Dark text for items

  items.forEach((item, index) => {
    // S.No
    doc.text((index + 1).toString(), sNoX + 5, y)
    
    // Description
    doc.text(item.description, descX, y)
    
    // Amount - REMOVED 'Rs. ' prefix as requested
    const amtStr = item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })
    doc.text(amtStr, amtX - doc.widthOfString(amtStr), y)
    
    y += 25
  })

  // Final Divider
  drawLine(doc, y + 10)

  // --- FOOTER TOTALS ---
  y += 25 // Spacing
  const labelX = 380
  const valueAnchorX = 545

  doc.font('Helvetica').fontSize(10).fillColor('#000000')

  // Subtotal
  doc.text('Subtotal', labelX, y)
  const subTotalStr = `${data.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  doc.text(subTotalStr, valueAnchorX - doc.widthOfString(subTotalStr), y)
  
  // Tax Removed

  drawLine(doc, y + 20, 360, 555) // Small divider for total

  y += 25
  // Total
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000')
  doc.text('Total', labelX, y)
  const totalStr = `Rs. ${data.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  doc.text(totalStr, valueAnchorX - doc.widthOfString(totalStr), y)
}

/* ================= FOOTER ================= */
function drawFooter(doc: PDFKit.PDFDocument) {
  const bottomY = 750
  
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#95a5a6')
    .text(
      'This is a system generated invoice and does not require a physical signature',
      0,
      bottomY,
      { align: 'center', width: doc.page.width }
    )
}

/* ================= HELPERS ================= */
function drawLine(doc: PDFKit.PDFDocument, y: number, startX = 40, endX = 555) {
  doc
    .strokeColor('#ecf0f1') // Very light grey Line
    .lineWidth(1)
    .moveTo(startX, y)
    .lineTo(endX, y)
    .stroke()
}
