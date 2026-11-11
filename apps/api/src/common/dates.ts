// All billing dates are UTC calendar days (YYYY-MM-DD strings or UTC midnight).
export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const toDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
