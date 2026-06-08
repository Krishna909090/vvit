

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
