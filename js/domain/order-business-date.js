export const ORDER_DATE_TIME_ZONE = 'Asia/Bangkok';

export function canAdjustOrderBusinessDate(user) {
  return user?.role === 'admin' || user?.role === 'accounting';
}

function datePartsInTimeZone(value, timeZone = ORDER_DATE_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function timePartsInTimeZone(value, timeZone = ORDER_DATE_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

export function currentBusinessDateInputValue(now = new Date()) {
  return datePartsInTimeZone(now);
}

export function currentBusinessDateTimeInputValue(now = new Date()) {
  const date = datePartsInTimeZone(now);
  const time = timePartsInTimeZone(now);
  return date && time ? `${date}T${time.slice(0, 5)}` : '';
}

export function orderDateToInputValue(value, fallback = '') {
  return value ? (datePartsInTimeZone(value) || fallback) : fallback;
}

export function orderDateToDateTimeInputValue(value, fallback = '') {
  if (!value) return fallback;
  const date = datePartsInTimeZone(value);
  const time = timePartsInTimeZone(value);
  return date && time ? `${date}T${time.slice(0, 5)}` : fallback;
}

export function parseOrderBusinessDateTimeInput(value, now = new Date()) {
  const input = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) return { ok: false, message: 'Ngày giờ lên đơn không hợp lệ.' };

  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (calendarCheck.getUTCFullYear() !== year
      || calendarCheck.getUTCMonth() !== month - 1
      || calendarCheck.getUTCDate() !== day
      || hour > 23
      || minute > 59) {
    return { ok: false, message: 'Ngày giờ lên đơn không tồn tại.' };
  }

  const dateKey = input.slice(0, 10);
  const today = currentBusinessDateInputValue(now);
  if (dateKey > today) {
    return { ok: false, message: 'Ngày giờ lên đơn không được lớn hơn thời điểm hiện tại.' };
  }

  const timestamp = `${input}:00+07:00`;
  const parsedTimestamp = new Date(timestamp);
  const gracePeriodMs = 60 * 1000;
  if (Number.isNaN(parsedTimestamp.getTime()) || parsedTimestamp.getTime() > now.getTime() + gracePeriodMs) {
    return { ok: false, message: 'Ngày giờ lên đơn không được lớn hơn thời điểm hiện tại.' };
  }

  return { ok: true, value: timestamp, dateKey };
}

export function parseOrderBusinessDateInput(value, now = new Date()) {
  const input = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return { ok: false, message: 'Ngày lên đơn không hợp lệ.' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (calendarCheck.getUTCFullYear() !== year
      || calendarCheck.getUTCMonth() !== month - 1
      || calendarCheck.getUTCDate() !== day) {
    return { ok: false, message: 'Ngày lên đơn không tồn tại.' };
  }

  const today = currentBusinessDateInputValue(now);
  if (input > today) {
    return { ok: false, message: 'Ngày lên đơn không được lớn hơn ngày hiện tại.' };
  }

  // Keep the selected Vietnamese business day, but use the actual clock time
  // of finalization instead of making every order appear at 00:00.
  const businessTime = timePartsInTimeZone(now);
  return { ok: true, value: `${input}T${businessTime}+07:00`, dateKey: input };
}
