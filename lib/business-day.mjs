const taiwanOffset = 8 * 60 * 60 * 1000;
const dayLength = 24 * 60 * 60 * 1000;

export function businessDate(timestamp) {
  return new Date(timestamp + taiwanOffset).toISOString().slice(0, 10);
}

export function businessDayRange(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const start = Date.parse(date + "T00:00:00+08:00");
  return Number.isFinite(start) && businessDate(start) === date ? [start, start + dayLength] : null;
}
