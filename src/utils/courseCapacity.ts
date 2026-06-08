import { AppError } from './AppError';

type Tx = any;

const requireRow = async (tx: Tx, courseId: string, academicYearId: string) => {
  const existing = await tx.courseCapacity.findUnique({
    where: { courseId_academicYearId: { courseId, academicYearId } },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(
      `Capacity not configured for course=${courseId} in academicYear=${academicYearId}. ` +
      `Create it via POST /admin/academic/capacity before allotment.`,
      400,
    );
  }
};

export const getCourseCapacity = async (
  tx: Tx,
  courseId: string,
  academicYearId: string,
) => {
  await requireRow(tx, courseId, academicYearId);
  return tx.courseCapacity.findUniqueOrThrow({
    where: { courseId_academicYearId: { courseId, academicYearId } },
    select: { totalSeats: true, filledSeats: true },
  });
};

export const incrementCourseCapacity = async (
  tx: Tx,
  courseId: string,
  academicYearId: string,
) => {
  await requireRow(tx, courseId, academicYearId);
  await tx.courseCapacity.update({
    where: { courseId_academicYearId: { courseId, academicYearId } },
    data: { filledSeats: { increment: 1 } },
  });
};

export const decrementCourseCapacity = async (
  tx: Tx,
  courseId: string,
  academicYearId: string,
) => {
  await requireRow(tx, courseId, academicYearId);
  await tx.courseCapacity.update({
    where: { courseId_academicYearId: { courseId, academicYearId } },
    data: { filledSeats: { decrement: 1 } },
  });
};

export const tryAtomicIncrementCourseCapacity = async (
  tx: Tx,
  courseId: string,
  academicYearId: string,
): Promise<boolean> => {
  await requireRow(tx, courseId, academicYearId);
  const updated = await tx.$executeRaw`
    UPDATE "CourseCapacity"
    SET "filledSeats" = "filledSeats" + 1,
        "updatedAt" = NOW()
    WHERE "courseId" = ${courseId}
      AND "academicYearId" = ${academicYearId}
      AND "filledSeats" < "totalSeats"
  `;
  return updated > 0;
};

export const assertCourseHasSeat = async (
  tx: Tx,
  courseId: string,
  academicYearId: string,
) => {
  const { totalSeats, filledSeats } = await getCourseCapacity(tx, courseId, academicYearId);
  if (filledSeats >= totalSeats) {
    throw new AppError(`No seats available for this course in the selected academic year`, 409);
  }
};
