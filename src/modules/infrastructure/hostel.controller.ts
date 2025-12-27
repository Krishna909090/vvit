import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { HostelService } from './hostel.service';

export const createHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, type, capacity } = req.body;
    
    if (!name || !type || !capacity) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

    const hostel = await HostelService.createHostel(req.body, req.user?.userId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_CREATED,
        data: hostel
    });
});

export const getHostels = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const hostels = await HostelService.getAllHostels();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTELS_FETCHED,
        data: hostels
    });
});

export const getHostelById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const hostel = await HostelService.getHostelById(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: hostel
    });
});

export const updateHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    const updateData = req.body;

    const hostel = await HostelService.updateHostel(hostelId, updateData);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_UPDATED,
        data: hostel
    });
});

export const deleteHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    await HostelService.deleteHostel(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_DELETED || 'Hostel deleted successfully'
    });
});

// Hostel (Detailed)
export const createHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const block = await HostelService.createHostelBlock(req.body, req.user?.userId);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_BLOCK_CREATED,
        data: block
    });
});

export const createHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const room = await HostelService.createHostelRoom(req.body, req.user?.userId);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_ROOM_BEDS_CREATED,
        data: room
    });
});

// Hostel Block
export const getHostelBlocks = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.query;
    const blocks = await HostelService.getHostelBlocks(hostelId as string);
    sendResponse({ res, statusCode: 200, success: true, data: blocks });
});

export const getHostelBlockById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const block = await HostelService.getHostelBlockById(id);
    sendResponse({ res, statusCode: 200, success: true, data: block });
});

export const updateHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const updatedBlock = await HostelService.updateHostelBlock(id, req.body, req.user?.userId);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_BLOCK_UPDATED, data: updatedBlock });
});

export const deleteHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    await HostelService.deleteHostelBlock(id);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_BLOCK_DELETED });
});

// Hostel Room
export const getHostelRooms = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { blockId } = req.query;
    const rooms = await HostelService.getHostelRooms(blockId as string);
    sendResponse({ res, statusCode: 200, success: true, data: rooms });
});

export const getHostelRoomById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const room = await HostelService.getHostelRoomById(id);
    sendResponse({ res, statusCode: 200, success: true, data: room });
});

export const updateHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const updatedRoom = await HostelService.updateHostelRoom(id, req.body, req.user?.userId);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_ROOM_UPDATED, data: updatedRoom });
});

export const deleteHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    await HostelService.deleteHostelRoom(id);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_ROOM_DELETED });
});


// Update Admission Details (Accommodation & Fees)
// This is somewhat shared between Student management and Facilities/Finance.
// Placing in HostelController might make sense if viewed as "Accommodation Allocation" or StudentController.
// Given it handles both Hostel and Transport logic heavily, splitting it or keeping specific functions is tricky.
// Since it also manages Fees, it touches Finance.
// Let's keep it here or in a dedicated "AdmissionController"?
// For now, I'll place it in studentManagementController as it updates student admission details primarily.
// Actually, looking at the code, it imports AccommodationType from prisma.
