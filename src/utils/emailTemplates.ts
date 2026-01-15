export const getEntranceExamReceiptTemplate = (data: {
  studentName: string;
  applicationId: string;
  programName: string;
  transactionId: string;
  date: Date;
  supportEmail?: string;
}) => {
  const {
    studentName,
    applicationId,
    programName,
    transactionId,
    date,
    supportEmail = "admissions@vvit.edu.in"
  } = data;

  const dateObj = date ? new Date(date) : new Date();
  const formattedDate = dateObj.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata"
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>VVIT Application Confirmation</title>

  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #FCFCFD;
      font-family: Arial, Helvetica, sans-serif;
      color: #6E6C78;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #FCFCFD;
    }

    /* Banner */
    .banner-table {
      width: 100%;
      border-collapse: collapse;
      border-radius: 12px 12px 0 0;
      overflow: hidden;
    }
    
    .banner-bg {
      background-size: cover;
      background-position: center center;
      background-repeat: no-repeat;
      height: 220px;
    }
    
    .logo-cell {
      text-align: right;
      vertical-align: top;
      padding: 20px;
    }

    /* Content */
    .content {
      padding: 32px 40px 10px 40px;
      font-size: 14px;
      line-height: 1.75;
      color: #6E6C78;
    }

    .content p {
      margin: 0 0 14px 0;
    }

    .content strong {
      color: #131010;
    }

    /* Summary */
    .summary {
      margin: 10px 0 16px 18px;
      padding: 0;
    }

    .summary li {
      margin-bottom: 6px;
      padding-left: 4px;
      color: #6E6C78;
    }

    /* Signature */
    .signature {
      margin-top: 18px;
    }

    /* Divider */
    .divider {
      border-top: 1px solid #DEDFE3;
      margin: 20px 0 10px;
    }

    /* Social */
    .social {
      text-align: center;
      padding: 18px 0 10px;
    }

    .social img {
      width: 26px;
      margin: 0 6px;
      opacity: 0.6;
    }

    /* Welcome Card */
    .welcome-card {
      background-color: #3A3334;
      margin: 18px 20px 0 20px;
      border-radius: 10px;
      overflow: hidden;
    }

    .welcome-inner {
      display: flex;
      padding: 18px;
      gap: 14px;
      align-items: center;
    }

    .welcome-text h3 {
      margin: 0 0 8px 0;
      font-size: 18px;
      font-weight: 700;
      color: #FCFCFD;
    }

    .welcome-text p {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: #C0BCC1;
    }

    .welcome-img {
      width: 120px;
      border-radius: 6px;
      object-fit: cover;
    }

    /* CTA */
    .cta {
      display: inline-block;
      margin-top: 12px;
      padding: 10px 18px;
      background-color: #E5776B;
      color: #FCFCFD !important;
      text-decoration: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 700;
    }

    /* Watermark */
    .watermark {
      text-align: center;
      font-size: 96px;
      font-weight: 800;
      color: #FFCC99; /* Peach Orange */
      letter-spacing: 10px;
      margin: 8px 0 30px;
      line-height: 1;
    }

    @media (max-width: 600px) {
      .content {
        padding: 24px 20px 10px 20px;
      }

      .welcome-inner {
        flex-direction: column-reverse;
        text-align: left;
      }

      .welcome-img {
        width: 100%;
      }
    }
  </style>
</head>

<body>

  <div class="container">

    <!-- Banner -->
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td
          class="banner-bg"
          background="cid:banner"
          style="background-image: url('cid:banner');"
        >
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

      <p>
        Thank you for successfully submitting your application for admission to
        <strong>Vasireddy Venkatadri International Technological University</strong>.
      </p>

      <p>
        We confirm that your application has been received and recorded. The summary of your submission is provided below for reference:
      </p>

      <ul class="summary">
        <li><strong>Applicant Name:</strong> ${studentName}</li>
        <li><strong>Application ID:</strong> ${applicationId}</li>
        <li><strong>Transaction ID:</strong> ${transactionId}</li>
        <li><strong>Date & Time of Submission:</strong> ${formattedDate}</li>
      </ul>

      <p>
        Please find attached the application invoice / submission summary document containing the details you have provided.
      </p>

      <p>
        Your application will now be reviewed by the admissions team. Upon successful verification, you will receive an email with instructions regarding the entrance examination.
      </p>

      <p>
        For any queries, please contact us at <strong>${supportEmail}</strong>, mentioning your application ID.
      </p>

      <div class="signature">
        <p>Yours sincerely,<br><strong>Admissions Office</strong></p>
      </div>

      <div class="divider"></div>

      <!-- Social Icons -->
      <!--
      <div class="social">
        <img src="cid:twitter" alt="Twitter" />
        <img src="cid:facebook" alt="Facebook" />
        <img src="cid:linkedin" alt="LinkedIn" />
        <img src="cid:instagram" alt="Instagram" />
      </div>
      -->
    </div>

    <!-- Welcome Card -->
    <div class="welcome-card">
      <div class="welcome-inner">
        <div class="welcome-text">
          <h3>Welcome to VVITU</h3>
          <p>
           VVITU continues to grow as a beacon of innovation and excellence, striving to empower the next generation of engineers, technologists, and leaders who are capable of making meaningful contributions to society, both nationally and globally.

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
