// Barrel for the AdminStudentService. The implementation is split by domain
// across ./adminStudent/*.ts so each file stays readable. External callers
// continue to import { AdminStudentService } from './adminStudent.service' — the
// API surface is identical to the pre-split monolith.

import { ApplicationsService } from './adminStudent/applications';
import { AccommodationService } from './adminStudent/accommodation';
import { AdmissionService } from './adminStudent/admission';
import { WaitingListService } from './adminStudent/waitingList';

export const AdminStudentService = {
    ...ApplicationsService,
    ...AccommodationService,
    ...AdmissionService,
    ...WaitingListService,
};
