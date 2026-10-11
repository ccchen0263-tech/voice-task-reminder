/**
 * 規則式台灣口語時間解析。所有絕對日期使用裝置的本機時區。
 * normalizedText 供規則比對；任務名稱使用原始輸入，保留有意義的文字。
 */

const CHINESE_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3,
  四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function chineseNumberToString(token) {
  if (!/[十百]/u.test(token)) {
    return [...token].map((character) => CHINESE_DIGITS[character]).join('');
  }
  let total = 0;
  let current = 0;
  for (const character of token) {
    if (character === '十' || character === '百') {
      total += (current || 1) * (character === '十' ? 10 : 100);
      current = 0;
    } else {
      current = CHINESE_DIGITS[character];
    }
  }
  return String(total + current);
}

// 記錄正規化後每個字元對應的原始範圍，避免把任務中的中文數字也改寫。
function normalizeWithMap(value) {
  const original = String(value ?? '');
  let text = original;
  let map = Array.from({ length: original.length }, (_, index) => ({ start: index, end: index + 1 }));

  function replace(pattern, replacement) {
    let result = '';
    const resultMap = [];
    let previousEnd = 0;
    for (const match of text.matchAll(pattern)) {
      result += text.slice(previousEnd, match.index);
      resultMap.push(...map.slice(previousEnd, match.index));
      const replacementText = typeof replacement === 'function' ? replacement(match[0]) : replacement;
      const start = map[match.index]?.start ?? 0;
      const end = map[match.index + match[0].length - 1]?.end ?? start;
      result += replacementText;
      resultMap.push(...Array.from({ length: replacementText.length }, () => ({ start, end })));
      previousEnd = match.index + match[0].length;
    }
    result += text.slice(previousEnd);
    resultMap.push(...map.slice(previousEnd));
    text = result;
    map = resultMap;
  }

  replace(/[０-９]/gu, (character) => String(character.charCodeAt(0) - 0xff10));
  replace(/：/gu, ':');
  replace(/\s/gu, '');
  replace(/[零〇一二兩两三四五六七八九十百]+/gu, chineseNumberToString);
  replace(/[\p{P}\p{S}]/gu, (character) => character === ':' ? ':' : '');
  replace(/鐘頭|钟头/gu, '小時');
  replace(/個(?=半?小時)/gu, '');
  replace(/點鐘|点钟|點钟|点鐘|点|(?<!小)時/gu, '點');
  replace(/分(?:鐘|钟)?/gu, '分鐘');
  replace(/周/gu, '週');
  replace(/礼拜/gu, '禮拜');
  replace(/这/gu, '這');
  replace(/后天/gu, '後天');
  return { original, text, map };
}

export function normalizeText(text) {
  return normalizeWithMap(text).text;
}

const PERIOD_PATTERN = '(?:早上|早晨|上午|下午|晚上|晚間|中午|凌晨|午夜|傍晚|早|晚)';
const DATE_PATTERN = '(?:今天|今日|明天|明早|明晚|今晚|今早|後天|(?:下|這|本)(?:週|禮拜|星期)(?:[1-7]|日|天))';
const CLOCK_PATTERN = '(?:[0-9]+點(?:[0-9]+(?:分鐘)?|半)?|[0-9]+:[0-9]+)';

function originalSpan(normalized, start, end) {
  if (end <= start || !normalized.map[start]) return null;
  return { start: normalized.map[start].start, end: normalized.map[end - 1].end };
}

function makeTitle(original, spans) {
  const ranges = spans.filter(Boolean).sort((a, b) => a.start - b.start);
  let title = '';
  let previousEnd = 0;
  for (const range of ranges) {
    title += original.slice(previousEnd, Math.max(previousEnd, range.start));
    previousEnd = Math.max(previousEnd, range.end);
  }
  title += original.slice(previousEnd);
  return title.replace(/\s+/gu, ' ').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').trim();
}

function result(normalized, start = 0, length = 0, reminderAt = null, explanation = '未辨識出明確時間，提醒時間未設定。', extraSpans = []) {
  const span = originalSpan(normalized, start, start + length);
  const reminderSpans = [...normalized.text.matchAll(/提醒我/gu)].map((match) =>
    originalSpan(normalized, match.index, match.index + match[0].length));
  return {
    title: makeTitle(normalized.original, [span, ...extraSpans, ...reminderSpans]),
    reminderAt,
    normalizedText: normalized.text,
    matchedTimeText: span ? normalized.original.slice(span.start, span.end).trim() : '',
    explanation,
  };
}

function relativeDate(now, minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isSafeInteger(minutes * 60_000)) return null;
  const date = new Date(now.getTime() + minutes * 60_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function unsupportedDateIndex(text) {
  // 僅檢查提醒語句的時間部分，避免把「交五月報告」等任務內容當成日期。
  const reminderIndex = text.indexOf('提醒我');
  const clockIndex = text.search(new RegExp(CLOCK_PATTERN, 'u'));
  const boundary = reminderIndex >= 0 ? reminderIndex : clockIndex >= 0 ? clockIndex : text.length;
  const prefix = text.slice(0, boundary);
  const pattern = /昨天|前天|大後天|下下(?:週|禮拜|星期)|下個(?:月|週|禮拜|星期)|(?:這|本)個月|(?:明|今)年|(?:下|這|本)(?:週|禮拜|星期)(?:[0-9]{2,}|[089]|(?![1-7日天]))|(?<!下|這|本)(?:週|禮拜|星期)[1-7日天]|[0-9]+(?:年|月|日|號)/u;
  const match = pattern.exec(prefix);
  return match ? match.index : -1;
}

function validOriginalNumber(normalized, start, length) {
  const span = originalSpan(normalized, start, start + length);
  if (!span) return true;
  const raw = normalized.original.slice(Math.max(0, span.start - 1), span.end);
  // 去除標點的正規化不能讓負數、小數或不完整的冒號時間意外變成合法時間。
  return !/(?:[-−負][\s]*[０-９0-9零〇一二兩两三四五六七八九十百])|[０-９0-9][.．][０-９0-9]/u.test(raw);
}

function readClock(clock, period) {
  const match = /^([0-9]+)(?:點(?:([0-9]+)(?:分鐘)?|(半))?|:([0-9]+))$/u.exec(clock);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[3] ? 30 : Number(match[2] ?? match[4] ?? 0);
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute) || hour > 23 || minute > 59) return null;

  if (/^(早上|早晨|上午|早|凌晨|午夜)$/u.test(period)) {
    if (hour > 12) return null;
    if (hour === 12) hour = 0;
  } else if (/^(下午|晚上|晚間|傍晚|晚|中午)$/u.test(period)) {
    if (hour === 0) return null;
    if (hour < 12) hour += 12;
    // 晚上 12 點為該晚結束時的午夜；上午 12 點為當日開始的午夜。
    if (hour === 12 && /^(晚上|晚間|晚)$/u.test(period)) return { hour: 0, minute, nextDay: true };
  }
  return { hour, minute, nextDay: false };
}

function dateForToken(token, now) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/^明/u.test(token)) date.setDate(date.getDate() + 1);
  else if (token === '後天') date.setDate(date.getDate() + 2);
  else if (/^(下|這|本)(週|禮拜|星期)/u.test(token)) {
    const weekdayText = token.slice(-1);
    const weekday = weekdayText === '日' || weekdayText === '天' ? 7 : Number(weekdayText);
    const mondayOffset = (now.getDay() + 6) % 7;
    date.setDate(date.getDate() - mondayOffset + (token.startsWith('下') ? 7 : 0) + weekday - 1);
  }
  return date;
}

/** @returns {{title: string, reminderAt: string|null, normalizedText: string, matchedTimeText: string, explanation: string}} */
export function parseTaskInput(text, now = new Date()) {
  const normalized = normalizeWithMap(text);
  const value = normalized.text;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return result(normalized, 0, 0, null, '目前日期無效，提醒時間未設定。');
  }

  const unsupportedIndex = unsupportedDateIndex(value);
  if (unsupportedIndex >= 0) {
    const reminderIndex = value.indexOf('提醒我', unsupportedIndex);
    const clock = new RegExp(CLOCK_PATTERN, 'u').exec(value.slice(unsupportedIndex));
    const end = reminderIndex >= 0 ? reminderIndex : clock ? unsupportedIndex + clock.index + clock[0].length : unsupportedIndex;
    return result(normalized, unsupportedIndex, end - unsupportedIndex, null, '此日期描述尚未支援，提醒時間未設定。');
  }

  const relative = /(?<![0-9])(?:([0-9]+)(?:半小時|小時半)|半小時|([0-9]+)小時(?:([0-9]+)分鐘)?|([0-9]+)分鐘)後/u.exec(value);
  if (relative) {
    let minutes;
    if (relative[1] !== undefined) minutes = Number(relative[1]) * 60 + 30;
    else if (relative[0].startsWith('半')) minutes = 30;
    else if (relative[2] !== undefined) minutes = Number(relative[2]) * 60 + Number(relative[3] ?? 0);
    else minutes = Number(relative[4]);
    const reminderAt = validOriginalNumber(normalized, relative.index, relative[0].length) ? relativeDate(now, minutes) : null;
    return result(normalized, relative.index, relative[0].length, reminderAt,
      reminderAt ? `設定為 ${minutes} 分鐘後。` : '時間格式不合法，提醒時間未設定。');
  }

  const vague = /等1下|待會|(?<![明今天0-9])晚1點/u.exec(value);
  if (vague) {
    const minutes = vague[0] === '晚1點' ? 60 : 10;
    return result(normalized, vague.index, vague[0].length, relativeDate(now, minutes), `「${normalized.original.slice(normalized.map[vague.index].start, normalized.map[vague.index + vague[0].length - 1].end)}」預設為 ${minutes} 分鐘後。`);
  }

  const dated = new RegExp(DATE_PATTERN, 'u').exec(value);
  let start = 0;
  let length = 0;
  let dateToken = '';
  let period = '';
  let clock = '';
  if (dated) {
    start = dated.index;
    dateToken = dated[0];
    length = dateToken.length;
    const tail = value.slice(start + length);
    const time = new RegExp(`^(?:的)?(${PERIOD_PATTERN})?(${CLOCK_PATTERN})?`, 'u').exec(tail);
    if (time) {
      length += time[0].length;
      period = time[1] ?? '';
      clock = time[2] ?? '';
    }
    if (!period && /早$/u.test(dateToken)) period = '早上';
    if (!period && /晚$/u.test(dateToken)) period = '晚上';
  } else {
    const time = new RegExp(`(?<![0-9:])(${PERIOD_PATTERN})?(${CLOCK_PATTERN})(?![0-9:])`, 'u').exec(value);
    if (time) {
      start = time.index;
      length = time[0].length;
      period = time[1] ?? '';
      clock = time[2];
    }
  }

  const sleep = /睡前/u.exec(value);
  const sleepSpan = sleep ? originalSpan(normalized, sleep.index, sleep.index + sleep[0].length) : null;
  if (!clock) {
    if (dateToken === '明早' || dateToken === '明晚') {
      const date = dateForToken(dateToken, now);
      date.setHours(dateToken === '明早' ? 8 : 19, 0, 0, 0);
      if (!sleep) return result(normalized, start, length, date.toISOString(), `「${dateToken}」預設為 ${dateToken === '明早' ? '早上 8' : '晚上 7'} 點。`);
    }
    if (sleep) return result(normalized, length ? start : sleep.index, length || sleep[0].length, null, '「睡前」沒有明確鐘點，提醒時間未設定。', [sleepSpan]);
    return result(normalized, start, length, null, dateToken ? '已辨識日期，但沒有明確鐘點，提醒時間未設定。' : undefined);
  }

  const parsedClock = readClock(clock, period);
  const date = dateForToken(dateToken, now);
  if (!parsedClock || !validOriginalNumber(normalized, start, length) || value[start + length] === ':') {
    return result(normalized, start, length, null, '時間格式不合法，提醒時間未設定。', [sleepSpan]);
  }
  if (parsedClock.nextDay) date.setDate(date.getDate() + 1);
  date.setHours(parsedClock.hour, parsedClock.minute, 0, 0);
  return result(normalized, start, length, date.toISOString(), '已依裝置本機時區設定提醒時間。', [sleepSpan]);
}
