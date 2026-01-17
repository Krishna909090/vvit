import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails, addInvigilator, getStaffUsers, updateStaffUser, deleteStaffUser,
    getSystemSettings, updateSystemSetting, updateAgentCommissionStatus
} from './general.controller';
import {
    addAdminSchema, getAgentCommissionsSchema, addInvigilatorSchema, updateStaffUserSchema
} from '../../validators/adminValidators';

const router = Router();

// Admin Operations
router.get('/dashboard-stats', authenticate, authorizePermission('admin.read'), getDashboardStats);

// Add Admin
router.post('/add-admin', authenticate, authorizePermission('admin.create'), validateRequest(addAdminSchema), addAdmin);

// Add Invigilator
router.post('/add-invigilator', authenticate, authorizePermission('admin.create'), validateRequest(addInvigilatorSchema), addInvigilator);

// Agent Commissions (Module: finance)
router.get('/commissions', authenticate, authorizePermission('finance.read'), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

// User Details
router.get('/user-details', authenticate, authorizePermission('admin.read'), getUserDetails);

// Get Staff Users
router.get('/staff-users', authenticate, authorizePermission('admin.read'), getStaffUsers);

// Update Staff User
router.put('/staff-users/:userId', authenticate, authorizePermission('admin.update'), validateRequest(updateStaffUserSchema), updateStaffUser);

// Delete Staff User

router.delete('/staff-users/:userId', authenticate, authorizePermission('admin.delete'), deleteStaffUser);

// System Settings (Module: system - user listed modules must be followed. System is not in the explicit list: Academics, Exam, Hostel, Finance, Transport, Admission, Library, HR. But "Any future module". Let's use 'system.read'/'system.update' if we treat System as a module, or 'admin.read'/'admin.update').
// Given "System Settings", let's use 'admin.read' / 'admin.update' to be safe and consolidated.
router.get('/settings', authenticate, authorizePermission('admin.read'), getSystemSettings);
router.post('/settings/:key', authenticate, authorizePermission('admin.update'), updateSystemSetting); // Using POST/PUT semantics

// Commission Status (Module: finance)
router.put('/commissions/:id/status', authenticate, authorizePermission('finance.update'), updateAgentCommissionStatus);

export default router;



