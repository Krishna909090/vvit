import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails, addInvigilator, getStaffUsers, updateStaffUser, deleteStaffUser,
    getSystemSettings, updateSystemSetting, updateAgentCommissionStatus, assignUserRoleAndGroups
} from './general.controller';
import {
    addAdminSchema, getAgentCommissionsSchema, addInvigilatorSchema, updateStaffUserSchema, assignRoleGroupSchema
} from '../../validators/adminValidators';

const router = Router();

// Admin Operations
// Admin Operations
router.get('/dashboard-stats', authenticate, authorizePermission('admin.read.all'), getDashboardStats);

// Add Admin
router.post('/add-admin', authenticate, authorizePermission('admin.create.all'), validateRequest(addAdminSchema), addAdmin);

// Add Invigilator
router.post('/add-invigilator', authenticate, authorizePermission('admin.create.all'), validateRequest(addInvigilatorSchema), addInvigilator);

// Agent Commissions
router.get('/commissions', authenticate, authorizePermission('admin.read.all'), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

// User Details
router.get('/user-details', authenticate, authorizePermission('admin.read.all'), getUserDetails);

// Get Staff Users
router.get('/staff-users', authenticate, authorizePermission('admin.read.all'), getStaffUsers);

// Update Staff User
router.put('/staff-users/:userId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateStaffUserSchema), updateStaffUser);

// Delete Staff User

router.delete('/staff-users/:userId', authenticate, authorizePermission('admin.delete.all'), deleteStaffUser);

// Assign Role and Groups (New API)
router.post('/assign-role-group', authenticate, authorizePermission('admin.update.all'), validateRequest(assignRoleGroupSchema), assignUserRoleAndGroups);

// System Settings
router.get('/settings', authenticate, authorizePermission('admin.read.all'), getSystemSettings);
router.post('/settings/:key', authenticate, authorizePermission('admin.update.all'), updateSystemSetting); // Using POST/PUT semantics

// Commission Status
router.put('/commissions/:id/status', authenticate, authorizePermission('admin.update.all'), updateAgentCommissionStatus);

export default router;



