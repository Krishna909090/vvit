import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

export interface CustodianCertData {
  admissionNo: string;
  studentName: string;
  gender: string;
  fatherName?: string;
  branch?: string;
  rank?: string | null;
  hallTicketNo: string;
  academicYear: string;
  entryYear: number;
  documentsSubmitted?: { key: string; label: string; status: 'SUBMITTED' | 'PENDING' }[];
  date?: Date;
}

interface DocEntry {
  key: string;
  label: string;
  inTable: boolean; // false = only appears in pending section
}

const ALL_DOCS: DocEntry[] = [
  { key: 'DOC_SSC_MARKSHEET',         label: 'SSC or Equivalent Marks List',                                    inTable: true  },
  { key: 'DOC_INTER_MARKSHEET',        label: 'Intermediate/Diploma or Equivalent Marks List',                   inTable: true  },
  { key: 'DOC_EAPCET_HALL_TICKET',     label: 'EAPCET Hall Ticket',                                             inTable: true  },
  { key: 'DOC_EAPCET_RANK_CARD',       label: 'EAPCET Rank Card',                                               inTable: true  },
  { key: 'DOC_STUDY_CERTIFICATE',      label: 'Study Certificates (VI to X, Intermediate/Diploma)',             inTable: true  },
  { key: 'DOC_TRANSFER_CERTIFICATE',   label: 'Transfer Certificate (Intermediate/Diploma)',                     inTable: true  },
  { key: 'DOC_CASTE_CERTIFICATE',      label: 'Caste Certificate (If Caste other than OC)',                     inTable: true  },
  { key: 'DOC_AADHAR_STUDENT',         label: 'Aadhar Card (Self)',                                             inTable: true  },
  { key: 'DOC_AADHAR_FATHER',          label: 'Father Aadhar Card',                                             inTable: true  },
  { key: 'DOC_AADHAR_MOTHER',          label: 'Mother Aadhar Card',                                             inTable: true  },
  { key: 'DOC_PHOTO_STUDENT',          label: 'Photograph (Self)',                                              inTable: true  },
  { key: 'DOC_PHOTO_FATHER',           label: 'Father Photograph',                                              inTable: true  },
  { key: 'DOC_PHOTO_MOTHER',           label: 'Mother Photograph',                                              inTable: true  },
  { key: 'DOC_XEROX_COPIES',           label: 'Xerox Copies 2 sets',                                            inTable: false }, // always shown in pending
];

const TABLE_DOCS = ALL_DOCS.filter(d => d.inTable);

// Exported so other modules can derive labels without duplicating the list
export const DOC_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ALL_DOCS.map(d => [d.key, d.label])
);

function formatAcademicYear(code: string): string {
  const parts = code.split('-');
  if (parts.length === 2) {
    const start = parts[0].trim();
    const end   = parts[1].trim();
    return `${start}–${end.length === 2 ? `20${end}` : end}`;
  }
  return code;
}


export const generateCustodianCertificate = (data: CustodianCertData): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
      const buffers: Buffer[] = [];
      doc.on('data',  c  => buffers.push(c));
      doc.on('end',   () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageW = doc.page.width;   // 595
      const ML    = 45;
      const MR    = 45;
      const cW    = pageW - ML - MR;  // 505

      const allDocs        = data.documentsSubmitted ?? [];
      const submittedDocs  = allDocs.filter(d => d.status === 'SUBMITTED');
      const pendingDocs    = allDocs.filter(d => d.status === 'PENDING').map(d => d.label);

      let y = 22;

      const logoPath = path.join(process.cwd(), 'src/assets/logo.png');
      const logoExists = fs.existsSync(logoPath);

      // ── WATERMARK ─────────────────────────────────────────────────────────
      if (logoExists) {
        const wmW = 280;
        doc.save().opacity(0.07)
          .image(logoPath, (pageW - wmW) / 2, (doc.page.height - wmW) / 2, { width: wmW })
          .restore();
      }

      // ── LOGO ──────────────────────────────────────────────────────────────
      if (logoExists) {
        const lw = 48;
        doc.image(logoPath, (pageW - lw) / 2, y, { width: lw });
        y += lw + 4;
      } else {
        y += 8;
      }

      // ── UNIVERSITY NAME ────────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#C62828');
      doc.text('VASIREDDY VENKATADRI INTERNATIONAL TECHNOLOGICAL UNIVERSITY',
        ML, y, { width: cW, align: 'center' });
      y = doc.y + 2;

      // ── ADDRESS ────────────────────────────────────────────────────────────
      doc.font('Helvetica').fontSize(8.5).fillColor('#000000');
      doc.text('Uppalapadu Road, Nambur, Pedhakakani Mandal, Guntur, Andhra Pradesh – 522508',
        ML, y, { width: cW, align: 'center' });
      y = doc.y + 5;

      // ── SEPARATOR ──────────────────────────────────────────────────────────
      doc.save().dash(4, { space: 3 }).strokeColor('#777777').lineWidth(0.8)
        .moveTo(ML, y).lineTo(pageW - MR, y).stroke().restore();
      y += 14;

      // ── TITLE ──────────────────────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#000000');
      doc.text('CUSTODIAN CERTIFICATE', ML, y, { width: cW, align: 'center' });
      y = doc.y + 4;

      doc.font('Helvetica-Oblique').fontSize(10.5);
      doc.text(`(Academic Year ${formatAcademicYear(data.academicYear)})`, ML, y, { width: cW, align: 'center' });
      y = doc.y + 14;

      // ── DATE ROW ───────────────────────────────────────────────────────────
      const dateStr = (data.date ?? new Date()).toLocaleDateString('en-IN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
      });
      const dotX = pageW - MR - 165;
      const dotW = 130;

      doc.font('Helvetica').fontSize(10).fillColor('#000000')
        .text('Date :', dotX - 50, y, { width: 46, align: 'right', lineBreak: false });
      doc.save().strokeColor('#000').lineWidth(0.4).dash(2, { space: 2 })
        .moveTo(dotX, y + 12).lineTo(dotX + dotW, y + 12).stroke().restore();
      doc.font('Helvetica').fontSize(10)
        .text(dateStr, dotX, y, { width: dotW, align: 'center', lineBreak: false });
      y += 26;

      // ── RECEIVED FROM / S/O D/O ────────────────────────────────────────────
      const genderPrefix = (data.gender || '').toLowerCase() === 'female' ? 'Ms.' : 'Mr.';
      const soLabel      = (data.gender || '').toLowerCase() === 'female' ? 'D/o' : 'S/o';

      // Single flowing paragraph — bold values inline, wraps naturally
      doc.font('Helvetica').fontSize(10.5).fillColor('#000000')
        .text(`Received from ${genderPrefix}/Ms. `, ML, y, { continued: true, width: cW });
      doc.font('Helvetica-Bold')
        .text((data.studentName || '') + ' ', { continued: true, width: cW });
      doc.font('Helvetica')
        .text('bearing Application No. ', { continued: true, width: cW });
      doc.font('Helvetica-Bold')
        .text((data.admissionNo || '') + ' ', { continued: true, width: cW });
      doc.font('Helvetica')
        .text(`${soLabel}, D/o `, { continued: true, width: cW });
      doc.font('Helvetica-Bold')
        .text((data.fatherName || '') + ' ', { continued: true, width: cW });
      doc.font('Helvetica')
        .text('and Branch ', { continued: true, width: cW });
      doc.font('Helvetica-Bold')
        .text((data.branch || '') + ' ', { continued: true, width: cW });
      doc.font('Helvetica')
        .text('the following certificates in Originals are submitted for verification at the college.', { width: cW });
      y = doc.y + 14;

      // ── DOCUMENT TABLE (submitted docs only, two-column side by side) ───────
      // Only show docs that belong in the table (inTable: true) in the submitted section
      const submittedTableDocs = submittedDocs.filter(d => TABLE_DOCS.some(t => t.key === d.key));
      const splitAt   = Math.ceil(submittedTableDocs.length / 2);
      const leftDocs  = submittedTableDocs.slice(0, splitAt);
      const rightDocs = submittedTableDocs.slice(splitAt);

      const colGap  = 20;
      const halfW   = (cW - colGap) / 2;
      const lNumX   = ML,            lNumW = 22;
      const lDescX  = lNumX + lNumW, lDescW = halfW - lNumW;
      const rNumX   = ML + halfW + colGap, rNumW = 22;
      const rDescX  = rNumX + rNumW, rDescW = halfW - rNumW;
      const divX    = ML + halfW + colGap / 2;

      // Single centred header — no # symbols, just the label centred across full table
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#444444')
        .text('CERTIFICATE DESCRIPTION', ML, y, { width: cW, align: 'center', lineBreak: false });
      y += 14;

      doc.strokeColor('#000000').lineWidth(0.8)
        .moveTo(ML, y).lineTo(pageW - MR, y).stroke();
      y += 6;

      const rowH     = 22;
      const rowTextY = 5;
      const rowCount = Math.max(leftDocs.length, rightDocs.length);

      // Vertical divider spanning full table
      const tableTopY = y;

      for (let i = 0; i < rowCount; i++) {
        const rowY = y + rowTextY;

        if (leftDocs[i]) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#000000')
            .text(`${i + 1}.`, lNumX, rowY, { width: lNumW, lineBreak: false });
          doc.text(leftDocs[i].label, lDescX, rowY, { width: lDescW, lineBreak: false });
        }

        if (rightDocs[i]) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#000000')
            .text(`${leftDocs.length + i + 1}.`, rNumX, rowY, { width: rNumW, lineBreak: false });
          doc.text(rightDocs[i].label, rDescX, rowY, { width: rDescW, lineBreak: false });
        }

        y += rowH;
        doc.strokeColor('#000000').lineWidth(0.4)
          .moveTo(ML, y).lineTo(pageW - MR, y).stroke();
      }

      // Vertical divider line between columns
      doc.strokeColor('#CCCCCC').lineWidth(0.6)
        .moveTo(divX, tableTopY - 5).lineTo(divX, y).stroke();

      doc.fillColor('#000000');
      y += 16;

      // ── PENDING CERTIFICATES ───────────────────────────────────────────────
      // Header — centred, same style as CERTIFICATE DESCRIPTION above
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#444444')
        .text('PENDING CERTIFICATES', ML, y, { width: cW, align: 'center', lineBreak: false });
      y += 14;

      doc.strokeColor('#000000').lineWidth(0.8)
        .moveTo(ML, y).lineTo(pageW - MR, y).stroke();
      y += 6;

      // Items aligned with the table's number + description columns
      const pendNumW = lNumW;          // same as table # col
      const pendTxtX = ML + pendNumW;
      const pendTxtW = cW - pendNumW;
      const romanH = 24;

      const pendRows = Math.max(pendingDocs.length, 1);
      for (let p = 0; p < pendRows; p++) {
        const iy = y + p * romanH + 5;
        doc.font('Helvetica').fontSize(10).fillColor('#000000')
          .text(`${p + 1}.`, ML, iy, { width: pendNumW + 10, lineBreak: false });
        if (pendingDocs[p]) {
          doc.font('Helvetica').fontSize(10).fillColor('#000000')
            .text(pendingDocs[p], pendTxtX + 12, iy, { width: pendTxtW - 12, lineBreak: false });
        }
        doc.strokeColor('#000000').lineWidth(0.4)
          .moveTo(ML, y + (p + 1) * romanH).lineTo(pageW - MR, y + (p + 1) * romanH).stroke();
      }

      y += pendRows * romanH + 30;

      // ── SIGNATURE BLOCK 1 ─────────────────────────────────────────────────
      const sigW  = 185;
      const sigLX = ML;
      const sigRX = pageW - MR - sigW;

      doc.strokeColor('#000000').lineWidth(0.7)
        .moveTo(sigLX, y).lineTo(sigLX + sigW, y).stroke()
        .moveTo(sigRX, y).lineTo(sigRX + sigW, y).stroke();
      y += 9;

      doc.font('Helvetica').fontSize(9.5).fillColor('#000000')
        .text('Signature of the Candidate', sigLX, y, { width: sigW, align: 'center', lineBreak: false });
      doc.text('Authorized Signatory',       sigRX, y, { width: sigW, align: 'center', lineBreak: false });
      y += 50;

      // ── CONSENT / UNDERTAKING ─────────────────────────────────────────────
      // Section header
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#444444')
        .text('Consent', ML, y, { width: cW, align: 'center', lineBreak: false });
      y += 14;

      doc.strokeColor('#000000').lineWidth(0.8)
        .moveTo(ML, y).lineTo(pageW - MR, y).stroke();
      y += 10;

      const uSize = 10.5;

      // Single flowing paragraph — bold name inline, date gap as underscored blank
      doc.font('Helvetica').fontSize(uSize).fillColor('#000000')
        .text('I,  ', ML, y, { continued: true, width: cW });
      doc.font('Helvetica-Bold').fontSize(uSize)
        .text((data.studentName || '___________________') + '  ', { continued: true, width: cW });
      doc.font('Helvetica').fontSize(uSize)
        .text(
          'will submit the certificates which are due as mentioned under "Not Submitted" ' +
          'category above in original on or before  ________________________  ' +
          'to the Director, admissions in person failing which I will forego my provisional allotment.',
          { width: cW },
        );
      y = doc.y + 40;

      // ── SIGNATURE BLOCK 2 ─────────────────────────────────────────────────
      doc.strokeColor('#000000').lineWidth(0.7)
        .moveTo(sigLX, y).lineTo(sigLX + sigW, y).stroke()
        .moveTo(sigRX, y).lineTo(sigRX + sigW, y).stroke();
      y += 9;

      doc.font('Helvetica').fontSize(9.5).fillColor('#000000')
        .text('Signature of the Candidate', sigLX, y, { width: sigW, align: 'center', lineBreak: false });
      doc.text('Signature of the Parent/Guardian', sigRX, y, { width: sigW, align: 'center', lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};
