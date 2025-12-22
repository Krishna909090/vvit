export const v4 = jest.fn(() => '1234-5678-9101');
export const v1 = jest.fn();
export const validate = jest.fn(() => true);
const uuid = { v4, v1, validate };
export default uuid;
