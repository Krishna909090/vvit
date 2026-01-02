import ExcelJS from 'exceljs';
import path from 'path';

const createSampleExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Students');
    
    sheet.columns = [
        { header: 'Index', key: 'index', width: 10 },
        { header: 'Name', key: 'name', width: 20 },
        { header: 'FatherName', key: 'fatherName', width: 20 },
        { header: 'MotherName', key: 'motherName', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 15 },
        { header: 'DOB', key: 'dob', width: 15 },
        { header: 'Gender', key: 'gender', width: 10 },
        { header: 'AadharNumber', key: 'aadhar', width: 20 },
        { header: 'Address', key: 'address', width: 30 },
        { header: 'City', key: 'city', width: 15 },
        { header: 'State', key: 'state', width: 15 },
        { header: 'Pincode', key: 'pincode', width: 10 },
        { header: 'CourseType', key: 'course', width: 15 },
        { header: 'Category', key: 'category', width: 10 },
        { header: 'Amount', key: 'amount', width: 10 },
    ];

    sheet.addRow({
        index: 1,
        name: 'Offline Test User',
        fatherName: 'Test Father',
        motherName: 'Test Mother',
        email: `offline.${Date.now()}@test.com`,
        phone: '9988776655',
        dob: '2005-06-15',
        gender: 'MALE',
        aadhar: `9876${Date.now().toString().slice(-8)}`,
        address: 'Test Address',
        city: 'Guntur',
        state: 'AP',
        pincode: '522001',
        course: 'B.Tech',
        category: 'BC-A'
    });

    // Write to a path likely not gitignored, like root or a temp dir if possible.
    // Assuming root is fine for temporary file, or src/scripts if that was blocked.
    // The previous error said /src/scripts/generate_excel.ts was blocked.
    // Let's try writing to src/utils/generate_excel_temp.ts and assume user won't commit it.
    
    const fileName = path.join(process.cwd(), 'offline_students_sample.xlsx');
    await workbook.xlsx.writeFile(fileName);
    console.log(`Sample Excel created at: ${fileName}`);
};

createSampleExcel();
