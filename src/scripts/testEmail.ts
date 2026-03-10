import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { generateInvoicePDF, InvoiceData } from '../utils/invoiceGenerator';

const ZEPTO_API_URL = process.env.ZEPTO_API_URL || 'https://api.zeptomail.in/v1.1/email';
const ZEPTO_API_KEY = process.env.ZEPTO_API_KEY;
const ZEPTO_FROM_EMAIL = process.env.ZEPTO_FROM_EMAIL || '';
const ZEPTO_FROM_NAME = process.env.ZEPTO_FROM_NAME || '';

async function sendTestEmail() {
    if (!ZEPTO_API_KEY) {
        console.error('ZEPTO_API_KEY is not set in environment');
        process.exit(1);
    }

    // Generate sample invoice
    const sampleInvoice: InvoiceData = {
        invoiceNumber: 'VVITU/2026/SAMPLE-001/001',
        date: new Date(),
        studentName: 'Sri Krishna B H',
        studentId: 'APP-2026-SAMPLE',
        paymentMethod: 'CASH',
        transactionId: 'CASH_1234567890_sample',
        referenceId: 'REC-SAMPLE-001',
        amount: 500,
        description: 'Application Fee',
        items: [{ description: 'Application Fee', amount: 500 }],
        academicYear: 'Academic Year 2026–2027',
        counterName: 'Admin User',
        address: {
            line1: 'Sample Address Line 1',
            line2: 'Sample Address Line 2',
            city: 'Guntur',
            state: 'Andhra Pradesh',
            pincode: '522508'
        }
    };

    console.log('Generating sample invoice PDF...');
    const pdfBuffer = await generateInvoicePDF(sampleInvoice);
    console.log(`Invoice PDF generated (${pdfBuffer.length} bytes)`);

    const toEmail = 'bhsrikrishna1994@gmail.com';
    const subject = 'Sample Invoice - VVITU ERP System';
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2 style="color: #C0392B;">VVITU ERP System - Sample Invoice</h2>
            <p>Please find the sample invoice attached with the following new features:</p>
            <ul>
                <li><strong>Academic Year</strong> - shown in Invoice Details section</li>
                <li><strong>Counter Name</strong> - shown at the bottom (for non-student payments)</li>
            </ul>
            <p><strong>Sent at:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
            <hr/>
            <p style="color: #999; font-size: 12px;">This is an automated test email from VVITU ERP System.</p>
        </div>
    `;

    try {
        const base64Pdf = pdfBuffer.toString('base64');

        const payload = {
            from: { address: ZEPTO_FROM_EMAIL, name: ZEPTO_FROM_NAME },
            to: [{ email_address: { address: toEmail } }],
            subject,
            htmlbody: htmlContent,
            attachments: [{
                name: 'Sample_Invoice_VVITU.pdf',
                mime_type: 'application/pdf',
                content: base64Pdf
            }]
        };

        const response = await axios.post(ZEPTO_API_URL, payload, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': ZEPTO_API_KEY
            },
            timeout: 30000
        });

        console.log('Email sent successfully!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        console.error('Failed to send email:', error.response?.data || error.message);
    }
}

sendTestEmail();
