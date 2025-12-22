import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';

interface InvoiceData {
    invoiceNumber: string;
    date: Date;
    studentName: string;
    studentId: string; // Application ID or Roll No
    paymentMethod: string;
    transactionId: string;
    amount: number;
    description: string; // "Application Fee", "Tuition Fee"
    address: {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        pincode: string;
    };
}

export const generateInvoicePDF = async (data: InvoiceData): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const buffers: Buffer[] = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', (err) => reject(err));

            generateHeader(doc);
            generateCustomerInformation(doc, data);
            generateInvoiceTable(doc, data);
            generateFooter(doc);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
};

function generateHeader(doc: PDFKit.PDFDocument) {
    const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
    if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 50 });
    }

    doc.fillColor('#444444')
        .fontSize(20)
        .text('VVITU College of Engineering', 110, 57)
        .fontSize(10)
        .text('(Autonomous)', 110, 80)
        .text('Nambur, Guntur, Andhra Pradesh', 200, 65, { align: 'right' })
        .text('support@vvitedu.in', 200, 80, { align: 'right' })
        .moveDown();

    doc.moveTo(50, 105).lineTo(550, 105).stroke();
}

function generateCustomerInformation(doc: PDFKit.PDFDocument, data: InvoiceData) {
    doc.fillColor('#444444').fontSize(20).text('INVOICE', 50, 130);

    generateHr(doc, 155);

    const customerInformationTop = 170;

    doc.fontSize(10)
        .text('Invoice Number:', 50, customerInformationTop)
        .font('Helvetica-Bold')
        .text(data.invoiceNumber, 150, customerInformationTop)
        .font('Helvetica')
        .text('Invoice Date:', 50, customerInformationTop + 15)
        .text(format(data.date, 'dd/MM/yyyy'), 150, customerInformationTop + 15)
        .text('Transaction ID:', 50, customerInformationTop + 30)
        .text(data.transactionId, 150, customerInformationTop + 30)
        .text('Payment Method:', 50, customerInformationTop + 45)
        .text(data.paymentMethod, 150, customerInformationTop + 45)

        .font('Helvetica-Bold')
        .text(data.studentName, 300, customerInformationTop)
        .font('Helvetica')
        .text(`ID: ${data.studentId}`, 300, customerInformationTop + 15)
        .text(data.address.line1, 300, customerInformationTop + 30)
        .text(`${data.address.city}, ${data.address.state} - ${data.address.pincode}`, 300, customerInformationTop + 45)
        .moveDown();

    generateHr(doc, 225);
}

function generateInvoiceTable(doc: PDFKit.PDFDocument, data: InvoiceData) {
    let i;
    const invoiceTableTop = 270;

    doc.font('Helvetica-Bold');
    generateTableRow(
        doc,
        invoiceTableTop,
        'Item',
        'Description',
        'Amount'
    );
    generateHr(doc, invoiceTableTop + 20);
    doc.font('Helvetica');

    const amountStr = `INR ${data.amount.toFixed(2)}`;
    
    generateTableRow(
        doc,
        invoiceTableTop + 30,
        '1',
        data.description,
        amountStr
    );

    generateHr(doc, invoiceTableTop + 50);

    const subtotalPosition = invoiceTableTop + 70;
    generateTableRow(
        doc,
        subtotalPosition,
        '',
        'Total',
        amountStr
    );
    
    doc.font('Helvetica-Bold');
    doc.text('PAID', 50, subtotalPosition + 30, { align: 'center', width: 500 });
}

function generateFooter(doc: PDFKit.PDFDocument) {
    doc.fontSize(10)
        .text(
            'This is a computer generated invoice and does not require a physical signature.',
            50,
            720,
            { align: 'center', width: 500 }
        );
}

function generateTableRow(
    doc: PDFKit.PDFDocument,
    y: number,
    item: string,
    description: string,
    amount: string
) {
    doc.fontSize(10)
        .text(item, 50, y)
        .text(description, 150, y)
        .text(amount, 0, y, { align: 'right' });
}

function generateHr(doc: PDFKit.PDFDocument, y: number) {
    doc.strokeColor('#aaaaaa')
        .lineWidth(1)
        .moveTo(50, y)
        .lineTo(550, y)
        .stroke();
}
