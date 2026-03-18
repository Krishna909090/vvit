export type PaymentEmailType = 'APPLICATION_FEE' | 'ADMISSION_FEE' | 'TUITION_FEE' | 'BOOK_BANK_FEE' | 'HOSTEL_FEE' | 'TRANSPORT_FEE' | 'DEFAULT';
export interface PaymentEmailData {
    studentName: string;
    applicationId: string;
    transactionId: string;
    amount: number;
    date: Date;
    paymentType: PaymentEmailType; // New field to distinguish purpose
    customFeeType?: string; // Fallback for other types
    supportEmail?: string;
    programName?: string; // Optional context
    invoiceUrl?: string; // Link to invoice if needed
    allotmentOrderUrl?: string; // Link to allotment if needed (for Admission Fee)
}

// Prevent XSS in HTML email templates by escaping user-controlled strings
const escapeHtml = (str: string): string =>
    (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

export const getPaymentReceiptTemplate = (data: PaymentEmailData) => {
  const {
    studentName: rawName,
    applicationId: rawAppId,
    transactionId: rawTxnId,
    amount,
    date,
    paymentType,
    customFeeType,
    supportEmail = "admissions@vvit.edu.in",
    allotmentOrderUrl
  } = data;

  // Sanitize all user-controlled strings before embedding in HTML
  const studentName = escapeHtml(rawName);
  const applicationId = escapeHtml(rawAppId);
  const transactionId = escapeHtml(rawTxnId);

  const dateObj = date ? new Date(date) : new Date();
  const formattedDate = dateObj.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
    timeZone: "Asia/Kolkata"
  });

  // --- DYNAMIC CONTENT SELECTOR ---
  let title = "Payment Confirmation";
  let greetingIntro = "Payment Received";
  let bodyPara1 = "";
  let bodyPara2 = "";
  let nextSteps = "";

  // Helper to format fee name (e.g., TUITION_FEE -> Tuition Fee)
  const formatFeeName = (type: string) => {
      return type.replace(/_/g, ' ').replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase())));
  };
  
  const feeName = customFeeType || formatFeeName(paymentType);

  if (paymentType === 'APPLICATION_FEE') {
      title = "VVIT Application Confirmation";
      greetingIntro = "Successful Application Submission";
      bodyPara1 = `Thank you for successfully submitting your application for admission to <strong>Vasireddy Venkatadri International Technological University</strong>.`;
      bodyPara2 = `We confirm that your Entrance Exam Fee payment of <strong>₹${amount}</strong> has been received and recorded.`;
      nextSteps = `Your application will now be reviewed by the admissions team. Upon successful verification, you will receive instructions regarding the entrance examination phase.`;
  } else if (paymentType === 'ADMISSION_FEE') {
      title = "Admission Fee Receipt";
      greetingIntro = "Admission Fee Payment Successful";
      bodyPara1 = `We are pleased to inform you that your Admission Fee payment has been successfully processed for <strong>Vasireddy Venkatadri International Technological University</strong>.`;
      bodyPara2 = `We confirm that a payment of <strong>₹${amount}</strong> has been credited to your student account against provisional admission.`;
      
      let downloadLink = "";
      if (allotmentOrderUrl) {
          downloadLink = `<br><br><a href="${allotmentOrderUrl}" style="background-color: #E5776B; color: #fff; padding: 10px 15px; text-decoration: none; border-radius: 5px; font-weight: bold;">Download Provision Allotment Order</a>`;
      }
      
      nextSteps = `Your seat has been provisionally confirmed${allotmentOrderUrl ? ' and your Provisional Allotment Order is available for download' : ''}. Please report to the college administration office for final document verification within the stipulated timeline.${downloadLink}`;
  } else {
      // Dynamic Handler for Tution, Book Bank, etc.
      title = `${feeName} Receipt`;
      greetingIntro = `${feeName} Payment Successful`;
      bodyPara1 = `Thank you for your ${feeName} payment to <strong>Vasireddy Venkatadri International Technological University</strong>.`;
      bodyPara2 = `We confirm that a payment of <strong>₹${amount}</strong> has been successfully processed and credited to your account.`;
      nextSteps = "Please keep this email for your records. You can view your updated fee status in the student portal.";
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>

  <style>
    body { margin: 0; padding: 0; background-color: #FCFCFD; font-family: Arial, Helvetica, sans-serif; color: #6E6C78; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FCFCFD; }
    /* Banner */
    .banner-table { width: 100%; border-collapse: collapse; border-radius: 12px 12px 0 0; overflow: hidden; }
    .banner-bg { background-size: cover; background-position: center center; background-repeat: no-repeat; height: 220px; }
    .logo-cell { text-align: right; vertical-align: top; padding: 20px; }
    /* Content */
    .content { padding: 32px 40px 10px 40px; font-size: 14px; line-height: 1.75; color: #6E6C78; }
    .content p { margin: 0 0 14px 0; }
    .content strong { color: #131010; }
    /* Summary */
    .summary { margin: 10px 0 16px 18px; padding: 0; }
    .summary li { margin-bottom: 6px; padding-left: 4px; color: #6E6C78; }
    /* Signature */
    .signature { margin-top: 18px; }
    /* Divider */
    .divider { border-top: 1px solid #DEDFE3; margin: 20px 0 10px; }
    /* Welcome Card */
    .welcome-card { background-color: #3A3334; margin: 18px 20px 0 20px; border-radius: 10px; overflow: hidden; }
    .welcome-inner { display: flex; padding: 18px; gap: 14px; align-items: center; }
    .welcome-text h3 { margin: 0 0 8px 0; font-size: 18px; font-weight: 700; color: #FCFCFD; }
    .welcome-text p { margin: 0; font-size: 13px; line-height: 1.6; color: #C0BCC1; }
    .welcome-img { width: 120px; border-radius: 6px; object-fit: cover; }
    /* CTA */
    .cta { display: inline-block; margin-top: 12px; padding: 10px 18px; background-color: #E5776B; color: #FCFCFD !important; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 700; }
    /* Watermark */
    .watermark { text-align: center; font-size: 96px; font-weight: 800; color: #FFCC99; letter-spacing: 10px; margin: 8px 0 30px; line-height: 1; }
    @media (max-width: 600px) {
      .content { padding: 24px 20px 10px 20px; }
      .welcome-inner { flex-direction: column-reverse; text-align: left; }
      .welcome-img { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Banner -->
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="banner-bg" background="cid:banner" style="background-image: url('cid:banner');">
          <!--[if gte mso 9]>
          <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:220px;">
            <v:fill type="tile" src="cid:banner" color="#333333" />
            <v:textbox inset="0,0,0,0">
          <![endif]-->
          <div style="height: 220px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" height="100%">
              <tr>
                <td class="logo-cell">
                  <img src="cid:logo" alt="VVIT Logo" width="80" style="width:80px; height:auto;" />
                </td>
              </tr>
            </table>
          </div>
          <!--[if gte mso 9]>
            </v:textbox>
          </v:rect>
          <![endif]-->
        </td>
      </tr>
    </table>

    <!-- Main Content -->
    <div class="content">
      <p><strong>Dear ${studentName},</strong></p>

      <p><strong>${greetingIntro}</strong></p>

      <p>${bodyPara1}</p>

      <p>${bodyPara2}</p>

      <ul class="summary">
        <li><strong>Student Name:</strong> ${studentName}</li>
        <li><strong>Reference ID:</strong> ${applicationId}</li>
        <li><strong>Transaction ID:</strong> ${transactionId}</li>
        <li><strong>Date & Time:</strong> ${formattedDate}</li>
        <li><strong>Amount Paid:</strong> ₹${amount}</li>
      </ul>

      <p>Please find attached the payment receipt / invoice for this transaction.</p>

      <p>${nextSteps}</p>

      <p>
        For any queries, please contact us at <strong>${supportEmail}</strong>.
      </p>

      <div class="signature">
        <p>Yours sincerely,<br><strong>Admissions Office</strong></p>
      </div>

      <div class="divider"></div>
    </div>

    <!-- Welcome Card -->
    <div class="welcome-card">
      <div class="welcome-inner">
        <div class="welcome-text">
          <h3>Welcome to VVITU</h3>
          <p>
           VVITU continues to grow as a beacon of innovation and excellence, striving to empower the next generation of engineers.
          </p>
          <a href="https://vvitu.ac.in" class="cta">Check out About VVITU</a>
        </div>
        <img src="cid:students" class="welcome-img" alt="Students" />
      </div>
    </div>

    <!-- Watermark -->
    <div class="watermark">VVITU</div>

  </div>
</body>
</html>
`;
};

export interface HallTicketEmailData {
    studentName: string;
    applicationId: string;
    examDate: string;
    startTime: string;
    examCenterName: string;
    examCenterAddress: string;
    supportEmail?: string;
}

export const getHallTicketTemplate = (data: HallTicketEmailData) => {
    const {
        studentName: rawName,
        applicationId: rawAppId,
        examDate,
        startTime,
        examCenterName: rawCenter,
        examCenterAddress: rawAddress,
        supportEmail = "admissions@vvit.edu.in"
    } = data;

    const studentName = escapeHtml(rawName);
    const applicationId = escapeHtml(rawAppId);
    const examCenterName = escapeHtml(rawCenter);
    const examCenterAddress = escapeHtml(rawAddress);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Hall Ticket Generated</title>
  <style>
    body { margin: 0; padding: 0; background-color: #FCFCFD; font-family: Arial, Helvetica, sans-serif; color: #6E6C78; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FCFCFD; }
    .banner-table { width: 100%; border-collapse: collapse; border-radius: 12px 12px 0 0; overflow: hidden; }
    .banner-bg { background-size: cover; background-position: center center; background-repeat: no-repeat; height: 220px; }
    .logo-cell { text-align: right; vertical-align: top; padding: 20px; }
    .content { padding: 32px 40px 10px 40px; font-size: 14px; line-height: 1.75; color: #6E6C78; }
    .content p { margin: 0 0 14px 0; }
    .content strong { color: #131010; }
    .summary { margin: 10px 0 16px 18px; padding: 0; }
    .summary li { margin-bottom: 6px; padding-left: 4px; color: #6E6C78; }
    .signature { margin-top: 18px; }
    .divider { border-top: 1px solid #DEDFE3; margin: 20px 0 10px; }
    .cta { display: inline-block; margin-top: 12px; padding: 10px 18px; background-color: #E5776B; color: #FCFCFD !important; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 700; }
    .watermark { text-align: center; font-size: 96px; font-weight: 800; color: #FFCC99; letter-spacing: 10px; margin: 8px 0 30px; line-height: 1; }
  </style>
</head>
<body>
  <div class="container">
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="banner-bg" background="cid:banner" style="background-image: url('cid:banner');">
          <!--[if gte mso 9]>
          <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:220px;">
            <v:fill type="tile" src="cid:banner" color="#333333" />
            <v:textbox inset="0,0,0,0">
          <![endif]-->
          <div style="height: 220px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" height="100%">
              <tr>
                <td class="logo-cell">
                  <img src="cid:logo" alt="VVIT Logo" width="80" style="width:80px; height:auto;" />
                </td>
              </tr>
            </table>
          </div>
          <!--[if gte mso 9]>
            </v:textbox>
          </v:rect>
          <![endif]-->
        </td>
      </tr>
    </table>

    <div class="content">
      <p><strong>Dear ${studentName},</strong></p>
      
      <p><strong>Hall Ticket Generated Successfully</strong></p>

      <p>Your Hall Ticket for the upcoming Entrance Examination at <strong>Vasireddy Venkatadri International Technological University</strong> has been generated.</p>

      <p>Please find the Hall Ticket attached to this email. You are required to carry a printed copy of this Hall Ticket along with a valid Government ID proof to the exam center.</p>

      <ul class="summary">
        <li><strong>Application ID:</strong> ${applicationId}</li>
        <li><strong>Exam Date:</strong> ${examDate}</li>
        <li><strong>Reporting Time:</strong> ${startTime}</li>
        <li><strong>Exam Center:</strong> ${examCenterName}</li>
        <li><strong>Location:</strong> ${examCenterAddress}</li>
      </ul>

      <p><strong>Important Instructions:</strong></p>
      <ul class="summary">
        <li>Please reach the exam center 30 minutes before the reporting time.</li>
        <li>Electronic gadgets are strictly prohibited inside the examination hall.</li>
        <li>Latecomers will not be allowed to enter.</li>
      </ul>

      <p>For any queries, please contact us at <strong>${supportEmail}</strong>.</p>

      <div class="signature">
        <p>Best regards,<br><strong>Examination Cell, VVITU</strong></p>
      </div>

      <div class="divider"></div>
       <div class="watermark">VVITU</div>
    </div>
  </div>
</body>
</html>
`;
};

export interface StatusUpdateEmailData {
    studentName: string;
    applicationId: string;
    updateType: 'QUALIFICATION_REJECTED' | 'DOCUMENT_REJECTED' | 'SEAT_ALLOTMENT_REJECTED' | 'EXAM_FAILED' | 'QUALIFICATION_PENDING' | 'DOCUMENT_PENDING' | 'QUALIFICATION_VERIFIED' | 'DOCUMENT_VERIFIED' | 'QUALIFICATION_STATUS' | 'DOCUMENT_STATUS';
    approvedItems?: { name: string; details?: string }[];
    rejectedItems?: { name: string; reason?: string }[];
    pendingItems?: { name: string; reason?: string }[];
    supportEmail?: string;
}

export const getStatusUpdateTemplate = (data: StatusUpdateEmailData) => {
    const {
        studentName: rawName,
        applicationId: rawAppId,
        updateType,
        approvedItems = [],
        rejectedItems = [],
        pendingItems = [],
        supportEmail = "admissions@vvit.edu.in"
    } = data;

    const studentName = escapeHtml(rawName);
    const applicationId = escapeHtml(rawAppId);

    let title = "Status Update";
    let greeting = "Application Status Update";
    let introText = "";
    let nextSteps = "";

    switch (updateType) {
        case 'QUALIFICATION_REJECTED':
            title = "Qualification Verification Status";
            greeting = "Action Required: Qualification Issues Found";
            introText = "During the verification of your academic qualifications, we found discrepancies that require your attention.";
            nextSteps = "Please review the rejected qualifications and upload the correct documents or update the information in your student dashboard.";
            break;
        case 'DOCUMENT_REJECTED':
            title = "Document Verification Status";
            greeting = "Action Required: Document Issues Found";
            introText = "We have reviewed your submitted documents. Some documents have been rejected due to quality issues or incorrect information.";
            nextSteps = "Please re-upload the rejected documents through the student portal immediately to process your admission.";
            break;
        case 'SEAT_ALLOTMENT_REJECTED':
            title = "Seat Allotment Status";
            greeting = "Seat Allotment Update";
            introText = "We regret to inform you that your seat allotment has been rejected/cancelled.";
            nextSteps = "Please contact the admissions office for further clarification regarding your seat status.";
            break;
        case 'EXAM_FAILED':
            title = "Entrance Exam Result";
            greeting = "Entrance Exam Result Status";
            introText = "We regret to inform you that you have not qualified in the recent entrance examination.";
            nextSteps = "You may re-apply for the next phase or contact the helpdesk for other admission options.";
            break;
        case 'QUALIFICATION_PENDING':
            title = "Qualification Verification Pending";
            greeting = "Action Required: Qualification Information Needed";
            introText = "Your academic qualification details are pending verification. It seems some information is missing or incomplete.";
            nextSteps = "Please login to your dashboard and complete your qualification details to proceed.";
            break;
        case 'DOCUMENT_PENDING':
            title = "Document Upload Pending";
            greeting = "Action Required: Documents Pending";
            introText = "Some of your required documents are pending upload or verification.";
            nextSteps = "Please upload the pending documents as soon as possible to avoid admission delays.";
            break;
        case 'QUALIFICATION_VERIFIED':
            title = "Qualification Verification Successful";
            greeting = "Good News: Qualifications Verified";
            introText = "We are pleased to inform you that your academic qualifications have been successfully verified.";
            nextSteps = "You can now proceed to the next stage of the admission process. Check your dashboard for updates.";
            break;
        case 'DOCUMENT_VERIFIED':
            title = "Documents Verification Successful";
            greeting = "Good News: Documents Verified";
            introText = "All your submitted documents have been successfully verified.";
            nextSteps = "Your application is moving forward. Please keep checking your dashboard for allotment status.";
            break;
        case 'QUALIFICATION_STATUS':
            title = "Qualification Verification Update";
            greeting = "Update: Qualification Verification Status";
            introText = "Here is the current status of your academic qualification verification.";
            nextSteps = "Please review the status details below. If any items are rejected or pending, please take necessary action.";
            break;
        case 'DOCUMENT_STATUS':
            title = "Document Verification Update";
            greeting = "Update: Document Verification Status";
            introText = "Here is the current status of your document verification.";
            nextSteps = "Please review the status details below. If any items are rejected or pending, please take necessary action.";
            break;
        default:
            title = "Status Update";
            greeting = "Application Status Update";
            introText = "There has been an update to your application status.";
            nextSteps = "Please login to the portal to view the details.";
    }

    const approvedListHtml = approvedItems.length > 0 ? `
        <p><strong>Approved:</strong></p>
        <ul style="list-style: none; padding: 0; margin-bottom: 20px;">
            ${approvedItems.map(item => `
                <li style="padding: 10px; margin-bottom: 8px; border-left: 4px solid #28a745; background-color: #f0fff4; border-radius: 4px;">
                    <span style="display: block; font-weight: bold; color: #155724;">${item.name}</span>
                    ${item.details ? `<span style="display: block; font-size: 13px; color: #28a745; margin-top: 4px;">${item.details}</span>` : ''}
                </li>
            `).join('')}
        </ul>
    ` : '';

    const pendingListHtml = pendingItems.length > 0 ? `
        <p><strong>Pending / Action Required:</strong></p>
        <ul style="list-style: none; padding: 0; margin-bottom: 20px;">
            ${pendingItems.map(item => `
                <li style="padding: 10px; margin-bottom: 8px; border-left: 4px solid #ffc107; background-color: #fffbf0; border-radius: 4px;">
                    <span style="display: block; font-weight: bold; color: #856404;">${item.name}</span>
                    ${item.reason ? `<span style="display: block; font-size: 13px; color: #856404; margin-top: 4px;">${item.reason}</span>` : ''}
                </li>
            `).join('')}
        </ul>
    ` : '';

    const rejectedListHtml = rejectedItems.length > 0 ? `
        <p><strong>Rejected:</strong></p>
        <ul style="list-style: none; padding: 0; margin-bottom: 20px;">
            ${rejectedItems.map(item => `
                <li style="padding: 10px; margin-bottom: 8px; border-left: 4px solid #dc3545; background-color: #fff5f5; border-radius: 4px;">
                    <span style="display: block; font-weight: bold; color: #721c24;">${item.name}</span>
                    ${item.reason ? `<span style="display: block; font-size: 13px; color: #dc3545; margin-top: 4px;">Reason: ${item.reason}</span>` : ''}
                </li>
            `).join('')}
        </ul>
    ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #FCFCFD; font-family: Arial, Helvetica, sans-serif; color: #6E6C78; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FCFCFD; }
    .banner-table { width: 100%; border-collapse: collapse; border-radius: 12px 12px 0 0; overflow: hidden; }
    .banner-bg { background-size: cover; background-position: center center; background-repeat: no-repeat; height: 220px; }
    .logo-cell { text-align: right; vertical-align: top; padding: 20px; }
    .content { padding: 32px 40px 10px 40px; font-size: 14px; line-height: 1.75; color: #6E6C78; }
    .content p { margin: 0 0 14px 0; }
    .content strong { color: #131010; }
    .summary { margin: 10px 0 16px 18px; padding: 0; }
    .summary li { margin-bottom: 6px; padding-left: 4px; color: #6E6C78; }
    .signature { margin-top: 18px; }
    .divider { border-top: 1px solid #DEDFE3; margin: 20px 0 10px; }
    .cta { display: inline-block; margin-top: 12px; padding: 10px 18px; background-color: #E5776B; color: #FCFCFD !important; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 700; }
    .watermark { text-align: center; font-size: 96px; font-weight: 800; color: #FFCC99; letter-spacing: 10px; margin: 8px 0 30px; line-height: 1; }
  </style>
</head>
<body>
  <div class="container">
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="banner-bg" background="cid:banner" style="background-image: url('cid:banner');">
          <!--[if gte mso 9]>
          <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:220px;">
            <v:fill type="tile" src="cid:banner" color="#333333" />
            <v:textbox inset="0,0,0,0">
          <![endif]-->
          <div style="height: 220px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" height="100%">
              <tr>
                <td class="logo-cell">
                  <img src="cid:logo" alt="VVIT Logo" width="80" style="width:80px; height:auto;" />
                </td>
              </tr>
            </table>
          </div>
          <!--[if gte mso 9]>
            </v:textbox>
          </v:rect>
          <![endif]-->
        </td>
      </tr>
    </table>

    <div class="content">
      <p><strong>Dear ${studentName},</strong></p>
      
      <p><strong>${greeting}</strong></p>

      <p>${introText}</p>

      ${rejectedListHtml}

      ${pendingListHtml}

      ${approvedListHtml}

      <p><strong>What to do next:</strong></p>
      <p>${nextSteps}</p>

      <p>For any queries, please contact us at <strong>${supportEmail}</strong>.</p>

      <div class="signature">
        <p>Best regards,<br><strong>Admissions Office, VVITU</strong></p>
      </div>

      <div class="divider"></div>
       <div class="watermark">VVITU</div>
    </div>
  </div>
</body>
</html>
`;
};
