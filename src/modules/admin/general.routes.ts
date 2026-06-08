import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails, addInvigilator, getStaffUsers, updateStaffUser, deleteStaffUser,
    getSystemSettings, updateSystemSetting, updateAgentCommissionStatus, assignUserRoleAndGroups, updateFullStaffDetails
} from './general.controller';
import {
    addAdminSchema, getAgentCommissionsSchema, addInvigilatorSchema, updateStaffUserSchema, assignRoleGroupSchema, updateFullStaffDetailsSchema
} from '../../validators/adminValidators';

const router = Router();

router.get('/dashboard-stats', authenticate, authorizePermission('admin.read.all'), getDashboardStats);

router.post('/add-admin', authenticate, authorizePermission('admin.create.all'), validateRequest(addAdminSchema), addAdmin);

router.post('/add-invigilator', authenticate, authorizePermission('admin.create.all'), validateRequest(addInvigilatorSchema), addInvigilator);

router.get('/user-details', authenticate, authorizePermission('admin.read.all'), getUserDetails);

router.get('/staff-users', authenticate, authorizePermission('admin.read.all'), getStaffUsers);

router.put('/staff-users/:userId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateStaffUserSchema), updateStaffUser);

router.put('/staff-users/:userId/full-update', authenticate, authorizePermission('admin.update.all'), validateRequest(updateFullStaffDetailsSchema), updateFullStaffDetails);

router.delete('/staff-users/:userId', authenticate, authorizePermission('admin.delete.all'), deleteStaffUser);

router.post('/assign-role-group', authenticate, authorizePermission('admin.update.all'), validateRequest(assignRoleGroupSchema), assignUserRoleAndGroups);

router.get('/commissions', authenticate, authorizePermission('admin.read.all'), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

router.put('/commissions/:id/status', authenticate, authorizePermission('admin.update.all'), updateAgentCommissionStatus);

router.get('/settings', authenticate, authorizePermission('admin.read.all'), getSystemSettings);

router.post('/settings/:key', authenticate, authorizePermission('admin.update.all'), updateSystemSetting);

export default router;
