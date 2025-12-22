import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
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
// Admin Operations
router.get('/dashboard-stats', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getDashboardStats);

// Add Admin
router.post('/add-admin', authenticate, authorize([Role.ADMIN,Role.SUPER_ADMIN]), validateRequest(addAdminSchema), addAdmin);

// Add Invigilator
router.post('/add-invigilator', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(addInvigilatorSchema), addInvigilator);

// Agent Commissions
router.get('/commissions', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

// User Details
router.get('/user-details', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getUserDetails);

// Get Staff Users
router.get('/staff-users', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getStaffUsers);

// Update Staff User
router.put('/staff-users/:userId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateStaffUserSchema), updateStaffUser);

// Delete Staff User

router.delete('/staff-users/:userId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteStaffUser);

// System Settings
router.get('/settings', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getSystemSettings);
router.post('/settings/:key', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSystemSetting); // Using POST/PUT semantics

// Commission Status
router.put('/commissions/:id/status', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateAgentCommissionStatus);

export default router;



