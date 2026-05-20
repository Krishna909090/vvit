import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../../utils/catchAsync';
import { MESSAGES } from '../../../constants/messages';
import { sendResponse } from '../../../utils/response';
import { HostelService } from './hostel.service';

export const createHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
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

export const getHostelFloors = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    const data = await HostelService.getHostelFloors(hostelId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data
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
    const { hostelId } = req.params;
    await HostelService.deleteHostel(hostelId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_DELETED || 'Hostel deleted successfully'
    });
});

// Hostel (Detailed)
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

export const createHostelRoomsBulk = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await HostelService.createHostelRoomsBulk(req.body, req.user?.userId);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Created ${result.createdCount} rooms successfully`,
        data: result
    });
});

// Hostel Room
export const getHostelRooms = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { blockId, hostelId, floor, includeBeds, roomNumber } = req.query;
    const truthy = (v: any) => v === true || v === 'true' || v === '1';
    const rooms = await HostelService.getHostelRooms({
        blockId: blockId as string,
        hostelId: hostelId as string,
        floor: floor !== undefined ? Number(floor) : undefined,
        includeBeds: truthy(includeBeds),
        roomNumber: roomNumber ? String(roomNumber).trim() : undefined,
    });
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
