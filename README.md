# College Admission System

## Overview
This is a robust College Admission Module built with Node.js, TypeScript, Express, and PostgreSQL (via Prisma). It supports Role-Based Access Control (RBAC) and covers the entire admission lifecycle.

## Features
- **RBAC**: Super Admin, Admin, Agent, Student.
- **Admission Flow**: Registration -> Test Fee -> Hall Ticket -> Exam -> Docs -> Seat Allotment -> Fee Payment.
- **File Upload**: Common API for uploading documents to AWS S3 with URL generation.
- **Branch Change**: With history logging.
- **Fee Reduction**: Approval workflow.
- **Logging**: Advanced logging with Winston (daily rotation).
- **Documentation**: Swagger UI.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Database Setup**
   - Ensure PostgreSQL is running.
   - Update `.env` with your `DATABASE_URL`.
   - Run migrations:
     ```bash
     npx prisma migrate dev --name init
     ```

3. **Run Application**
   - Development:
     ```bash
     npm run dev
     ```
   - Production:
     ```bash
     npm run build
     npm start
     ```

4. **API Documentation**
   - Visit `http://localhost:3000/api-docs` for Swagger UI.

## Environment Variables
Create a `.env` file:
```env
PORT=3000
DATABASE_URL="postgresql://user:password@localhost:5432/vvitu_admission?schema=public"
JWT_SECRET="your_jwt_secret"
AWS_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your_key"
AWS_SECRET_ACCESS_KEY="your_secret"
AWS_BUCKET_NAME="your_bucket"
```

## File Upload API
For detailed documentation on how to use the file upload API, see [FILE_UPLOAD_USAGE.md](./FILE_UPLOAD_USAGE.md).

**Quick Example:**
```bash
# Upload a single file
curl -X POST http://localhost:3000/api/upload/single?folder=id-proofs \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "file=@document.pdf"
```
