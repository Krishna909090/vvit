#!/bin/bash

# Base URL
BASE_URL="http://localhost:3000"
# Replace with your actual token
TOKEN="YOUR_ADMIN_TOKEN"

echo "------------------- QUALIFICATION REQUIREMENTS -------------------"

echo "1. Create Qualification Requirement (Single Rule - e.g. SSC)"
curl -X POST "$BASE_URL/qualification-requirements" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "degreeType": "B.Tech",
    "ruleType": "SINGLE",
    "qualificationKey": "SSC",
    "isRequired": true
  }'
echo -e "\n"

echo "2. Create Qualification Requirement (OR Rule - e.g. EAMCET OR JEE)"
curl -X POST "$BASE_URL/qualification-requirements" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "degreeType": "B.Tech",
    "ruleType": "OR",
    "qualificationKeys": ["EAMCET_RANK", "JEE_MAINS_RANK"],
    "isRequired": true
  }'
echo -e "\n"

echo "3. Get Qualification Requirements (Filter by B.Tech)"
curl -X GET "$BASE_URL/qualification-requirements?degreeType=B.Tech" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"

echo "4. Get Qualification Requirement By ID"
# Replace YOUR_REQ_ID with actual ID from GET response
REQ_ID="YOUR_REQ_ID"
curl -X GET "$BASE_URL/qualification-requirements/$REQ_ID" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"

echo "5. Update Qualification Requirement (Change isRequired)"
curl -X PUT "$BASE_URL/qualification-requirements/$REQ_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "isRequired": false
  }'
echo -e "\n"

echo "6. Deactivate Qualification Requirement (Delete)"
curl -X DELETE "$BASE_URL/qualification-requirements/$REQ_ID" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"

echo "7. Validate Student Qualifications"
curl -X POST "$BASE_URL/qualification-requirements/validate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "degreeType": "B.Tech",
    "qualifications": ["SSC", "EAMCET_RANK"]
  }'
echo -e "\n"

echo "------------------- DOCUMENT REQUIREMENTS -------------------"

echo "8. Create Document Requirement"
curl -X POST "$BASE_URL/document-requirements" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "degreeType": "B.Tech",
    "documentName": "SSC Marks Memo",
    "documentKey": "SSC_MEMO",
    "isRequired": true
  }'
echo -e "\n"

echo "9. Get Document Requirements"
curl -X GET "$BASE_URL/document-requirements?degreeType=B.Tech" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"

echo "10. Get Document Requirement By ID"
DOC_REQ_ID="YOUR_DOC_REQ_ID"
curl -X GET "$BASE_URL/document-requirements/$DOC_REQ_ID" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"

echo "11. Update Document Requirement"
curl -X PUT "$BASE_URL/document-requirements/$DOC_REQ_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "documentName": "SSC Marks Memo (Updated)",
    "isRequired": false
  }'
echo -e "\n"

echo "12. Deactivate Document Requirement (Delete)"
curl -X DELETE "$BASE_URL/document-requirements/$DOC_REQ_ID" \
  -H "Authorization: Bearer $TOKEN"
echo -e "\n"
