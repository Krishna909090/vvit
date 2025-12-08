# API Analysis Document

This document provides a comprehensive analysis of the API endpoints, including their request payloads and sample request bodies.

## 1. Authentication Module (`/auth`)

### 1.1. Send OTP
*   **Method:** `POST`
*   **Path:** `/auth/send-otp`
*   **Description:** Sends an OTP to the provided phone number or email for login/verification.
*   **Request Payload Keys:**
    *   `phone` (string, optional): 10-digit phone number.
    *   `email` (string, optional): Valid email address.
    *   `role` (enum, optional): One of `STUDENT`, `ADMIN`, `SUPER_ADMIN`, `AGENT`, `INVIGILATOR`.
    *   *Condition:* Either `phone` or `email` is required.
*   **Sample Request:**
    ```json
    {
      "phone": "9876543210",
      "role": "STUDENT"
    }
    ```
    OR
    ```json
    {
      "email": "student@example.com",
      "role": "STUDENT"
    }
    ```

### 1.2. Verify OTP
*   **Method:** `POST`
*   **Path:** `/auth/verify-otp`
*   **Description:** Verifies the OTP and logs the user in.
*   **Request Payload Keys:**
    *   `phone` (string, optional): 10-digit phone number.
    *   `email` (string, optional): Valid email address.
    *   `otp` (string, required): 6-digit OTP.
    *   *Condition:* Either `phone` or `email` is required.
*   **Sample Request:**
    ```json
    {
      "phone": "9876543210",
      "otp": "123456"
    }
    ```

---

## 2. Student Module (`/student`)

### 2.1. Register Student
*   **Method:** `POST`
*   **Path:** `/student/register`
*   **Description:** Registers a new student application.
*   **Request Payload Keys:**
    *   `name` (string, required)
    *   `fatherName` (string, required)
    *   `motherName` (string, required)
    *   `email` (string, required)
    *   `phone` (string, required, min 10 chars)
    *   `gender` (string, required)
    *   `dob` (string or date, required)
    *   `aadharNumber` (string, required, 12 chars)
    *   `category` (string, required)
    *   `country` (string, required)
    *   `address` (string, required)
    *   `address2` (string, optional)
    *   `city` (string, required)
    *   `state` (string, required)
    *   `pincode` (string, required, 6 chars)
    *   `courseType` (string, required)
    *   `pref1` (string, required)
    *   `pref2` (string, optional)
    *   `pref3` (string, optional)
    *   `profilePhotoUrl` (string, required, URL)
    *   `isOffline` (boolean, optional)
*   **Sample Request:**
    ```json
    {
      "name": "Rahul Sharma",
      "fatherName": "Rajesh Sharma",
      "motherName": "Sunita Sharma",
      "email": "rahul.sharma@example.com",
      "phone": "9876543210",
      "gender": "Male",
      "dob": "2005-08-15",
      "aadharNumber": "123456789012",
      "category": "General",
      "country": "India",
      "address": "123 Main St",
      "city": "Hyderabad",
      "state": "Telangana",
      "pincode": "500001",
      "courseType": "B.Tech",
      "pref1": "CSE",
      "pref2": "ECE",
      "profilePhotoUrl": "https://example.com/photo.jpg"
    }
    ```

### 2.2. Pay Test Fee
*   **Method:** `POST`
*   **Path:** `/student/:studentId/pay-test-fee`
*   **Description:** Initiates payment for the entrance test.
*   **Request Payload Keys:** None (Path parameter only).
*   **Sample Request:** (Empty Body)

### 2.3. Get Hall Ticket
*   **Method:** `GET`
*   **Path:** `/student/:studentId/hall-ticket`
*   **Description:** Retrieves the Hall Ticket URL.
*   **Request Payload Keys:** None (Path parameter only).

### 2.4. Upload Documents & Preferences
*   **Method:** `POST`
*   **Path:** `/student/:studentId/upload-docs`
*   **Description:** Uploads documents (marks memos, certificates) and updates branch preferences.
*   **Request Payload Keys:**
    *   `pref1` (string, optional)
    *   `pref2` (string, optional)
    *   `pref3` (string, optional)
    *   *Dynamic Keys:* Any key ending in `Url` (e.g., `marksheetUrl`, `tenthMarksheetUrl`).
*   **Sample Request:**
    ```json
    {
      "pref1": "CSE",
      "tenthMarksheetUrl": "https://example.com/10th.pdf",
      "twelfthMarksheetUrl": "https://example.com/12th.pdf"
    }
    ```

### 2.5. Pay College Fee
*   **Method:** `POST`
*   **Path:** `/student/:studentId/pay-college-fee`
*   **Description:** Initiates payment for the college admission fee.
*   **Request Payload Keys:** None (Path parameter only).

### 2.6. Request Discount
*   **Method:** `POST`
*   **Path:** `/student/:studentId/request-discount` (Assumed based on controller mapping)
*   **Description:** Requests a fee discount.
*   **Request Payload Keys:**
    *   `reason` (string, required)
    *   `documentUrl` (string, optional, URL)
*   **Sample Request:**
    ```json
    {
      "reason": "Merit Student",
      "documentUrl": "https://example.com/merit-cert.pdf"
    }
    ```

### 2.7. Add Academic Details
*   **Method:** `POST`
*   **Path:** `/student/:studentId/academic-details`
*   **Description:** Adds academic qualification details.
*   **Request Payload Keys:**
    *   `details` (array of objects, required)
        *   `level` (string, required) - e.g., "10th", "12th"
        *   `board` (string, required)
        *   `yearOfPassing` (number, required)
        *   `hallTicketNumber` (string, required)
        *   `gpaOrMarks` (string/number, required)
*   **Sample Request:**
    ```json
    {
      "details": [
        {
          "level": "10th",
          "board": "SSC",
          "yearOfPassing": 2021,
          "hallTicketNumber": "HT12345",
          "gpaOrMarks": 9.8
        },
        {
          "level": "12th",
          "board": "Intermediate",
          "yearOfPassing": 2023,
          "hallTicketNumber": "HT67890",
          "gpaOrMarks": 980
        }
      ]
    }
    ```

### 2.8. Select Exam Slot
*   **Method:** `POST`
*   **Path:** `/student/:studentId/select-exam`
*   **Description:** Selects an exam slot.
*   **Request Payload Keys:**
    *   `slotId` (uuid, required)
*   **Sample Request:**
    ```json
    {
      "slotId": "550e8400-e29b-41d4-a716-446655440000"
    }
    ```

### 2.9. Request Branch Change
*   **Method:** `POST`
*   **Path:** `/student/:studentId/branch-change` (Assumed based on controller mapping)
*   **Description:** Requests a change of branch.
*   **Request Payload Keys:**
    *   `newBranch` (string, required)
    *   `reason` (string, required)
*   **Sample Request:**
    ```json
    {
      "newBranch": "IT",
      "reason": "Personal Preference"
    }
    ```

---

## 3. Admin Module (`/admin`)

### 3.1. Add Admin
*   **Method:** `POST`
*   **Path:** `/admin/add-admin`
*   **Description:** Adds a new admin (Super Admin only).
*   **Request Payload Keys:**
    *   `phone` (string, required)
    *   `name` (string, optional)
    *   `email` (string, optional)
*   **Sample Request:**
    ```json
    {
      "phone": "9876543210",
      "name": "Admin User",
      "email": "admin@example.com"
    }
    ```

### 3.2. Mark Attendance
*   **Method:** `POST`
*   **Path:** `/admin/mark-attendance`
*   **Description:** Manually marks exam attendance.
*   **Request Payload Keys:**
    *   `studentId` (uuid, required)
    *   `attended` (boolean, required)
*   **Sample Request:**
    ```json
    {
      "studentId": "550e8400-e29b-41d4-a716-446655440000",
      "attended": true
    }
    ```

### 3.3. Verify & Allot Seat
*   **Method:** `POST`
*   **Path:** `/admin/verify-allot`
*   **Description:** Verifies documents and allots a seat.
*   **Request Payload Keys:**
    *   `studentId` (uuid, required)
    *   `approved` (boolean, required)
    *   `allottedBranch` (string, required only if `approved` is true)
*   **Sample Request:**
    ```json
    {
      "studentId": "550e8400-e29b-41d4-a716-446655440000",
      "approved": true,
      "allottedBranch": "CSE"
    }
    ```

### 3.4. Create Discount Request (Admin)
*   **Method:** `POST`
*   **Path:** `/admin/create-discount`
*   **Description:** Admin creates a discount request on behalf of a student.
*   **Request Payload Keys:**
    *   `studentId` (uuid, required)
    *   `reason` (string, required)
    *   `documentUrl` (string, optional)
*   **Sample Request:**
    ```json
    {
      "studentId": "550e8400-e29b-41d4-a716-446655440000",
      "reason": "Financial Hardship",
      "documentUrl": "https://example.com/income-cert.pdf"
    }
    ```

### 3.5. Review Discount Request
*   **Method:** `POST`
*   **Path:** `/admin/review-discount`
*   **Description:** Review and forward/reject a discount request.
*   **Request Payload Keys:**
    *   `requestId` (uuid, required)
    *   `remarks` (string, optional)
    *   `action` (string, required - FORWARD/REJECT)
*   **Sample Request:**
    ```json
    {
      "requestId": "550e8400-e29b-41d4-a716-446655440000",
      "action": "FORWARD",
      "remarks": "Verified documents"
    }
    ```

### 3.6. Approve Discount (Super Admin)
*   **Method:** `POST`
*   **Path:** `/admin/approve-discount`
*   **Description:** Final approval for discount.
*   **Request Payload Keys:**
    *   `requestId` (uuid, required)
    *   `approved` (boolean, required)
*   **Sample Request:**
    ```json
    {
      "requestId": "550e8400-e29b-41d4-a716-446655440000",
      "approved": true
    }
    ```

### 3.7. Update Exam Score
*   **Method:** `POST`
*   **Path:** `/admin/update-exam-score`
*   **Description:** Updates the exam score.
*   **Request Payload Keys:**
    *   `studentId` (uuid, required)
    *   `score` (number, required)
    *   `cutoff` (number, required)
*   **Sample Request:**
    ```json
    {
      "studentId": "550e8400-e29b-41d4-a716-446655440000",
      "score": 85,
      "cutoff": 50
    }
    ```

### 3.8. Create Transport Route
*   **Method:** `POST`
*   **Path:** `/admin/transport-route`
*   **Description:** Creates a new transport route.
*   **Request Payload Keys:**
    *   `name` (string, required)
    *   `cost` (number, required)
    *   `busNumber` (string, required)
    *   `capacity` (number, required)
*   **Sample Request:**
    ```json
    {
      "name": "Route 1 - Miyapur",
      "cost": 15000,
      "busNumber": "TS09UA1234",
      "capacity": 40
    }
    ```

### 3.9. Update Admission Details
*   **Method:** `POST`
*   **Path:** `/admin/update-admission`
*   **Description:** Updates hostel or transport allocation.
*   **Request Payload Keys:**
    *   `studentId` (uuid, required)
    *   `accommodationType` (enum: `HOSTEL`, `TRANSPORT`, `DAY_SCHOLAR`)
    *   `hostelType` (enum, optional: `SHARING_4`, `SHARING_8`) - Required if accommodationType is HOSTEL.
    *   `hostelId` (uuid, optional)
    *   `transportRouteId` (string, optional) - Required if accommodationType is TRANSPORT.
    *   `paidAmount` (number, optional)
*   **Sample Request:**
    ```json
    {
      "studentId": "550e8400-e29b-41d4-a716-446655440000",
      "accommodationType": "HOSTEL",
      "hostelType": "SHARING_4",
      "hostelId": "uuid-of-hostel"
    }
    ```

### 3.10. Admin List/Get/Create (ERP)
*   **Create Branch**: `POST /admin/branches` -> `{ "code": "CSE", "name": "Computer Science", "totalSeats": 120 }`
*   **Create Hostel**: `POST /admin/hostels` -> `{ "name": "Boys Hostel A", "type": "SHARING_4", "capacity": 100, "cost": 50000 }`

---

## 4. Exam Module (`/exam`)

### 4.1. Create Exam Center
*   **Method:** `POST`
*   **Path:** `/exam/centers`
*   **Description:** Creates a new exam center.
*   **Request Payload Keys:**
    *   `name` (string, required)
    *   `address` (string, optional)
    *   `city` (string, optional)
    *   `capacity` (number, optional)
*   **Sample Request:**
    ```json
    {
      "name": "Main Block - Lab 1",
      "address": "Campus Block A",
      "city": "Hyderabad",
      "capacity": 50
    }
    ```

### 4.2. Generate Invigilator Credentials
*   **Method:** `POST`
*   **Path:** `/exam/invigilators/generate`
*   **Description:** Generates login codes for invigilators.
*   **Request Payload Keys:**
    *   `validFrom` (date, required)
    *   `validUntil` (date, required)
    *   `count` (number, default 1)
*   **Sample Request:**
    ```json
    {
      "validFrom": "2024-05-01T09:00:00Z",
      "validUntil": "2024-05-01T12:00:00Z",
      "count": 5
    }
    ```

### 4.3. Create Exam Slot
*   **Method:** `POST`
*   **Path:** `/exam/slots`
*   **Description:** Creates a specific exam time slot.
*   **Request Payload Keys:**
    *   `examCenterId` (uuid, required)
    *   `date` (date string, required)
    *   `startTime` (datetime, required)
    *   `endTime` (datetime, required)
    *   `capacity` (number, required)
*   **Sample Request:**
    ```json
    {
      "examCenterId": "550e8400-e29b-41d4-a716-446655440000",
      "date": "2024-05-15",
      "startTime": "2024-05-15T09:00:00Z",
      "endTime": "2024-05-15T12:00:00Z",
      "capacity": 30
    }
    ```

### 4.4. Scan Attendance (Invigilator)
*   **Method:** `POST`
*   **Path:** `/exam/attendance/scan`
*   **Description:** Marks attendance via QR code scan.
*   **Request Payload Keys:**
    *   `qrHash` (string, required)
    *   `studentId` (uuid, optional - depends on QR content/impl)
    *   `slotId` (uuid, optional)
*   **Sample Request:**
    ```json
    {
      "qrHash": "encrypted-qr-string-data",
      "slotId": "slot-uuid"
    }
    ```

### 4.5. Invigilator Login
*   **Method:** `POST`
*   **Path:** `/exam/invigilators/login`
*   **Description:** Login for invigilators using generated token.
*   **Request Payload Keys:**
    *   `token` (string, required)
*   **Sample Request:**
    ```json
    {
      "token": "INV-12345-ABCde"
    }
    ```
