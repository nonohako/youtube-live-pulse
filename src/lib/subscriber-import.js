'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const DATE_HEADERS = new Set(['날짜', '일자', 'date']);
const TOTAL_HEADERS = new Set(['전체구독자', '총구독자', '구독자수', 'totalsubscribers']);

async function loadSubscriberRecords(filePath) {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new Error('.xlsx 형식의 엑셀 파일만 가져올 수 있습니다.');
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    throw new Error('선택한 엑셀 파일을 찾을 수 없습니다.');
  }
  if (!stats.isFile()) throw new Error('선택한 엑셀 파일을 찾을 수 없습니다.');
  if (stats.size > MAX_WORKBOOK_BYTES) {
    throw new Error('엑셀 파일이 너무 큽니다. 25MB 이하 파일을 선택해 주세요.');
  }

  let sheets;
  try {
    const { default: readExcelFile } = await import('read-excel-file/node');
    sheets = await readExcelFile(filePath);
  } catch {
    throw new Error('엑셀 파일을 읽지 못했습니다. 암호가 없는 정상적인 .xlsx 파일인지 확인해 주세요.');
  }

  const result = extractSubscriberRecords(sheets);
  if (!result.matchedSheets) {
    throw new Error('“날짜”와 “전체 구독자” 열을 찾지 못했습니다. 예시와 같은 형식인지 확인해 주세요.');
  }
  if (!result.records.length) {
    throw new Error('가져올 수 있는 날짜별 전체 구독자 기록이 없습니다.');
  }
  return result;
}

function extractSubscriberRecords(sheets) {
  const recordsByDate = new Map();
  let matchedSheets = 0;
  let invalidRows = 0;
  let duplicateRows = 0;

  for (const sheet of sheets || []) {
    const rows = Array.isArray(sheet?.data) ? sheet.data : [];
    const header = findHeader(rows);
    if (!header) continue;
    matchedSheets += 1;

    for (let rowNumber = header.rowNumber + 1; rowNumber < rows.length; rowNumber += 1) {
      const row = rows[rowNumber] || [];
      const rawDate = unwrapCellValue(row[header.dateColumn]);
      const rawCount = unwrapCellValue(row[header.countColumn]);
      if (isBlank(rawDate) && isBlank(rawCount)) continue;
      if (isSummaryLabel(rawDate)) continue;

      const dateParts = parseDateParts(rawDate);
      const count = parseSubscriberCount(rawCount);
      if (!dateParts || count === null) {
        invalidRows += 1;
        continue;
      }

      const dateKey = formatDateKey(dateParts);
      if (recordsByDate.has(dateKey)) duplicateRows += 1;
      recordsByDate.set(dateKey, {
        dateKey,
        at: localMidnightIso(dateParts),
        count
      });
    }
  }

  return {
    records: [...recordsByDate.values()].sort((left, right) => left.dateKey.localeCompare(right.dateKey)),
    matchedSheets,
    invalidRows,
    duplicateRows
  };
}

function mergeSubscriberHistory(history, records) {
  const existing = Array.isArray(history) ? [...history] : [];
  const existingDates = new Set(existing.map((sample) => localDateKey(sample?.at)).filter(Boolean));
  const addedRecords = [];
  let skippedExisting = 0;

  for (const record of records || []) {
    if (!record?.dateKey || !Number.isFinite(record.count)) continue;
    if (existingDates.has(record.dateKey)) {
      skippedExisting += 1;
      continue;
    }
    existingDates.add(record.dateKey);
    addedRecords.push({ at: record.at, count: Math.round(record.count) });
  }

  const merged = [...existing, ...addedRecords].sort((left, right) => {
    const leftTime = new Date(left?.at).getTime();
    const rightTime = new Date(right?.at).getTime();
    if (!Number.isFinite(leftTime)) return 1;
    if (!Number.isFinite(rightTime)) return -1;
    return leftTime - rightTime;
  });

  return {
    history: merged,
    added: addedRecords.length,
    skippedExisting,
    firstAddedDate: addedRecords[0]?.at || null,
    lastAddedDate: addedRecords.at(-1)?.at || null
  };
}

function findHeader(rows) {
  const lastHeaderRow = Math.min(50, rows.length);
  for (let rowNumber = 0; rowNumber < lastHeaderRow; rowNumber += 1) {
    const row = rows[rowNumber] || [];
    let dateColumn = null;
    let countColumn = null;
    row.forEach((value, columnNumber) => {
      const header = normalizeHeader(unwrapCellValue(value));
      if (DATE_HEADERS.has(header)) dateColumn = columnNumber;
      if (TOTAL_HEADERS.has(header)) countColumn = columnNumber;
    });
    if (dateColumn !== null && countColumn !== null) return { rowNumber, dateColumn, countColumn };
  }
  return null;
}

function parseDateParts(value, date1904 = false) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const isUtcMidnight = value.getUTCHours() === 0
      && value.getUTCMinutes() === 0
      && value.getUTCSeconds() === 0;
    return validateDateParts(isUtcMidnight
      ? { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
      : { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() });
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const wholeDays = Math.floor(value);
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const date = new Date(base + wholeDays * 24 * 60 * 60 * 1000);
    return validateDateParts({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate()
    });
  }

  const match = String(value || '').trim().match(/^(\d{4})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})\s*\.?$/);
  if (!match) return null;
  return validateDateParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  });
}

function validateDateParts(parts) {
  if (!parts || parts.year < 1900 || parts.year > 9999) return null;
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (date.getFullYear() !== parts.year
    || date.getMonth() !== parts.month - 1
    || date.getDate() !== parts.day) return null;
  return parts;
}

function parseSubscriberCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const normalized = String(value || '').replace(/[\s,]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function unwrapCellValue(value) {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (Object.hasOwn(value, 'result')) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (typeof value.text === 'string') return value.text;
  }
  return value;
}

function normalizeHeader(value) {
  return String(value || '').trim().replace(/[\s_()-]+/g, '').toLowerCase();
}

function formatDateKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function localMidnightIso({ year, month, day }) {
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return formatDateKey({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  });
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function isSummaryLabel(value) {
  return /^(합계|평균)$/i.test(String(value || '').trim());
}

module.exports = {
  extractSubscriberRecords,
  loadSubscriberRecords,
  localDateKey,
  mergeSubscriberHistory,
  parseDateParts,
  parseSubscriberCount
};
