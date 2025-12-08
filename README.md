# UI Field Specifications (Master Tables)

This document provides a consolidated tabular view of all User Interface fields required for the Facility Management modules.

## 1. Branch Management Module

| Screen / Action | Field Name | Input Type | Options / Data Source | Validation Rules | Logic / Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Create/Edit Branch** | Branch Name | Text | N/A | Required, Min 3 chars | Full name (e.g., "Computer Science") |
| | Branch Code | Text | N/A | Required, Unique, Uppercase | Short code (e.g., "CSE") |
| | Total Seats | Number | N/A | Required, Min 1 | Max intake capacity |
| | Description | Text Area | N/A | Optional | Internal notes |

## 2. Hostel Management Module

| Screen / Action | Field Name | Input Type | Options / Data Source | Validation Rules | Logic / Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Create Hostel** | Hostel Name | Text | N/A | Required | Name of building |
| | Hostel Type | Dropdown | `Boys`, `Girls` | Required | Restricts allocation by gender |
| | Total Capacity | Number | N/A | Required | Total beds in building |
| | Warden Name | Text | N/A | Optional | |
| **Create Block** | Select Hostel | Dropdown | API: `GET /hostels` | Required | Parent Hostel |
| | Block Name | Text | N/A | Required | e.g., "A-Block" |
| **Create Room** | Select Block | Dropdown | API: `GET /blocks` | Required | Parent Block |
| | Room Number | Text | N/A | Required | e.g., "101" |
| | Room Type | Dropdown | `AC`, `Non-AC` | Required | Affects Fee |
| | Sharing Mode | Dropdown | `2`, `4`, `8` | Required | Affects Fee |
| | Capacity | Number | Auto-filled (readonly) | Derived from Sharing Mode | |

## 3. Transport Management Module

| Screen / Action | Field Name | Input Type | Options / Data Source | Validation Rules | Logic / Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Add Vehicle** | Bus Number | Text | N/A | Required, Regex (Plate) | Physical Vehicle ID |
| | Capacity | Number | N/A | Required, Max 60 | Max seats |
| | Driver Name | Text | N/A | Required | |
| | Driver Mobile | Phone | N/A | Required, 10 digits | |
| **Create Route** | Route Name | Text | N/A | Required | e.g., "Route 5 - City" |
| | Assign Vehicle | Dropdown | API: `GET /vehicles` | Required | Links bus to route |
| | Annual Cost | Currency | N/A | Required | Fee added to student bill |
| | Start Time | Time | N/A | Required | Route start time |
| | City | City | N/A | Required | Route start time |
| **Add Stop** | Select Route | Dropdown | API: `GET /routes` | Required | Parent Route |
| | Stop Name | Text | N/A | Required | Pickup point name |
| | Sequence | Number | N/A | Required | Order (1, 2, 3...) |
| | Pickup Time | Time | N/A | Optional | |

## 4. Student Allocation (Counseling) Screen

| Section | Field Name | Input Type | Options / Data Source | Validation Rules | Logic / Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Admission** | Allotted Branch | Dropdown | API: `GET /branches` | Required | Shows available seats count |
| **Facility Toggle** | Need Facility? | Switch/Checkbox | `Yes` / `No` | N/A | Reveals Facility options |
| **Facility Type** | Accommodation | Radio Button | `Hostel`, `Transport` | Required if Toggle=Yes | Determines next fields |
| **If Hostel** | Hostel Type | Dropdown | `SHARING_4`, `SHARING_8` | Required | Filters buildings |
| | Select Hostel | Dropdown | API: `GET /hostels` (Filtered by Gender) | Required | Select Building |
| | Select Room | Dropdown | API: `GET /rooms` (Filtered by Vacancy) | Optional (V2) | Specific bed allocation |
| **If Transport** | Select Route | Dropdown | API: `GET /routes` | Required | Select Bus Route |
| | Select Stop | Dropdown | API: `GET /stops` (Filtered by Route) | Required | Pickup point |
| **Fee Summary** | Tuition Fee | Read-only | Fixed | N/A | Base Fee |
| | Facility Fee | Read-only | Dynamic | N/A | Derived from Hostel/Route |
| | **Total** | Read-only | Calculated Sum | N/A | Final Amount to Pay |
