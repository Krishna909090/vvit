
# API Documentation

| Module | Endpoint | Method | Use Case | Request Payload (Body/Params/Query) | Sample Request | Response (Success) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Auth** | `/auth/send-otp` | POST | Send OTP to phone number | `{ phone: string }` | `{ "phone": "9876543210" }` | OTP sent successfully |
| **Auth** | `/auth/verify-otp` | POST | Verify OTP and login | `{ phone: string, otp: string }` | `{ "phone": "9876543210", "otp": "123456" }` | Login successful, Token |
| **Student** | `/student/register` | POST | Register a new student application | `{ name, fatherName, motherName, gender, dob, phone, email, aadharNumber, category, country, address, city, state, pincode, profilePhotoUrl, courseType, ... }` | `{ "name": "Rahul", "phone": "9876543210", "email": "rahul@email.com", "courseType": "B.Tech", ... }` | Student registered successfully |
| **Student** | `/student/{studentId}/pay-test-fee` | POST | Mark test fee as paid | Path: `studentId` | URL: `.../student/uuid/pay-test-fee` | Test fee paid successfully |
| **Student** | `/student/{studentId}/hall-ticket` | GET | Get hall ticket URL | Path: `studentId` | URL: `.../student/uuid/hall-ticket` | Hall Ticket URL |
| **Student** | `/student/{studentId}/upload-docs` | POST | Upload documents & update preferences | `{ pref1, pref2, marksheetUrl, tcUrl, ... }` | `{ "pref1": "CSE", "marksheetUrl": "s3://..." }` | Documents uploaded successfully |
| **Student** | `/student/{studentId}/pay-college-fee` | POST | Pay college admission fee | Path: `studentId` | URL: `.../student/uuid/pay-college-fee` | College fee paid successfully |
| **Student** | `/student/{studentId}/academic-details` | POST | Add 10th/12th details | `{ details: [{ level, board, yearOfPassing, hallTicketNumber, gpaOrMarks }] }` | `{ "details": [{ "level": "10th", "board": "SSC", "yearOfPassing": "2021", ... }] }` | Academic details added |
| **Student** | `/student/{studentId}/select-exam` | POST | Select exam date/slot | `{ slotId: string }` | `{ "slotId": "slot-uuid" }` | Exam selected and Hall Ticket generated |
| **Student** | `/student/exam-slots` | GET | Get available exam slots | None | - | List of slots |
| **Student** | `/student/document-requirements` | GET | Get doc requirements for course | None | - | List of required docs |
| **Student** | `/student/{studentId}/document` | DELETE | Delete uploaded document | Path: `studentId`, Query: `documentKey` | URL: `.../document?documentKey=10th_marksheet` | Document deleted successfully |
| **Student** | `/student/{studentId}` | GET | Get student profile details | Path: `studentId` | URL: `.../student/uuid` | Student details JSON |
| **Admin** | `/admin/add-admin` | POST | Add new admin (Super Admin) | `{ name, email, password, phone }` | `{ "name": "Admin", "email": "admin@vvit.com", ... }` | Admin created successfully |
| **Admin** | `/admin/commissions` | GET | Get agent commissions | Query: `agentId` (optional) | - | List of commissions |
| **Admin** | `/admin/upload-results` | POST | Bulk upload results (CSV) | FormData: `file` | - | Results uploaded successfully |
| **Admin** | `/admin/hostels` | POST | Create Hostel | `{ name, type, capacity, fee, blockName, roomNumber }` | `{ "name": "Boys Hostel A", "type": "SHARING_4", "capacity": 100, ... }` | Hostel created |
| **Admin** | `/admin/hostels` | GET | List Hostels | None | - | List of hostels |
| **Admin** | `/admin/dashboard-stats` | GET | Get dashboard stats | None | - | Dashboard stats JSON |
| **Admin** | `/admin/applications` | GET | List applications | Query: `page`, `limit`, `search`, `status` | URL: `.../applications?status=REGISTERED&page=1` | List of applications |
| **Admin** | `/admin/mark-attendance` | POST | Mark student attendance | `{ studentId, attended }` | `{ "studentId": "uuid", "attended": true }` | Attendance marked |
| **Admin** | `/admin/verify-allot` | POST | Verify docs & allot seat | `{ studentId, allottedBranch }` | `{ "studentId": "uuid", "allottedBranch": "CSE" }` | Seat allotted successfully |
| **Admin** | `/admin/change-branch` | POST | Request branch change | `{ studentId, newBranch, reason }` | `{ "studentId": "uuid", "newBranch": "ECE", "reason": "Choice" }` | Branch change requested |
| **Admin** | `/admin/approve-branch-change` | POST | Approve branch change | `{ requestId, approved }` | `{ "requestId": "req-uuid", "approved": true }` | Branch change processed |
| **Admin** | `/admin/document-requirements` | POST | Add Doc Requirement | `{ name, key, courseType, isRequired }` | `{ "name": "10th Marks", "key": "10th_marks", "courseType": "B.Tech" }` | Requirement added |
| **Admin** | `/admin/verify-document/{studentId}` | POST | Verify single document | Path: `studentId`, Body: `{ documentKey, status, remarks }` | `{ "documentKey": "10th_marks", "status": "APPROVED" }` | Document status updated |
| **Exam** | `/exam/centers` | POST | Create Exam Center | `{ name, address, city, state, capacity }` | `{ "name": "Main Block", "city": "Hyd", "capacity": 500 }` | Exam center created |
| **Exam** | `/exam/slots` | POST | Create Exam Slot | `{ examCenterId, date, startTime, endTime, capacity }` | `{ "examCenterId": "uuid", "date": "2025-05-01", ... }` | Exam slot created |
| **Exam** | `/exam/invigilators/generate` | POST | Generate Credentials | `{ examCenterId, count }` | `{ "examCenterId": "uuid", "count": 5 }` | Credentials generated |
| **Exam** | `/exam/slots/{studentId}/book` | POST | Book Exam Slot | `{ slotId }` | `{ "slotId": "slot-uuid" }` | Slot booked successfully |
| **Invigilator** | `/invigilator/login` | POST | Login with Token | `{ token }` | `{ "token": "ABC123XY" }` | Login successful |
| **Invigilator** | `/invigilator/scan-qr` | POST | Scan Student QR | `{ qrHash }` | `{ "qrHash": "qr-uuid-hash" }` | Attendance marked |
| **Upload** | `/api/upload/single` | POST | Upload Single File | FormData: `file`, Query: `folder` | - | File uploaded successfully |

*Note: This is a high-level summary. For exact schema details, please refer to the Swagger documentation or the TypeScript interfaces.*
