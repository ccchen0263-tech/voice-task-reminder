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
const WEEK_WORD = '(?:週|禮拜|星期)';
const WEEKDAY = '(?:[1-7](?![0-9])|日|天)';
// 前面的「明天、下週一」等可以出現在任何位置；後面的「星期五、15號、12月1日」只在時間或「提醒我」之前才算日期，
// 避免把「買5號電池」這類任務內容誤當日期。
const DATE_PATTERN = `(?:今天|今日|明天|明早|明晚|今晚|今早|後天|(?:下|這|本)${WEEK_WORD}${WEEKDAY}|${WEEK_WORD}${WEEKDAY}(?!次|個|遍)|[0-9]{1,2}月[0-9]{1,2}(?:號|日)|(?<![0-9月])[0-9]{1,2}(?:號|日))`;
const RECURRENCE_PATTERN = new RegExp(
  `每(?:個)?${WEEK_WORD}1(?:到|至)${WEEK_WORD}?5|平日|每個?工作天|每(?:個)?(?:天|日)|每(?:個)?${WEEK_WORD}(?:${WEEKDAY}(?!次|個|遍))?|每(?:個)?月(?:[0-9]{1,2}(?:號|日))?|每年`, 'u');
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
    title: makeTitle(normalized.original, [span, ...extraSpans, ...reminderSpans, normalized.recurrenceSpan]),
    reminderAt,
    normalizedText: normalized.text,
    matchedTimeText: span ? normalized.original.slice(span.start, span.end).trim() : '',
    explanation,
    repeat: normalized.repeat ?? null,
    warning: '',
    adjustment: '',
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
  const pattern = /昨天|前天|大後天|下下(?:週|禮拜|星期)|下個(?:月|週|禮拜|星期)|(?:這|本)個月|(?:明|今)年|(?:下|這|本)(?:週|禮拜|星期)(?:[0-9]{2,}|[089]|(?![1-7日天]))|(?<![下這本])(?:週|禮拜|星期)(?:[0-9]{2,}|[089])|[0-9]+年|[0-9]+月(?![0-9]{1,2}(?:日|號))|[0-9]{3,}(?:日|號)/u;
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

function startOfDay(now, offsetDays = 0) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
}

function weekdayNumber(text) {
  return text === '日' || text === '天' ? 7 : Number(text);
}

/** 只處理不會「過期」的日期詞（今天、明天、這週X、下週X）。 */
function dateForToken(token, now) {
  const date = startOfDay(now);
  if (/^明/u.test(token)) date.setDate(date.getDate() + 1);
  else if (token === '後天') date.setDate(date.getDate() + 2);
  else if (/^(下|這|本)(週|禮拜|星期)/u.test(token)) {
    const weekday = weekdayNumber(token.slice(-1));
    const mondayOffset = (now.getDay() + 6) % 7;
    date.setDate(date.getDate() - mondayOffset + (token.startsWith('下') ? 7 : 0) + weekday - 1);
  }
  return date;
}

function withTime(date, clock) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (clock.nextDay ? 1 : 0));
  result.setHours(clock.hour, clock.minute, 0, 0);
  return result;
}

const formatClock = (date) => `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

/**
 * 依日期詞與鐘點算出提醒時間。
 * - 沒說日期：今天的時間已過時，若沒說上午/下午且下午的同一時間還沒到，就用下午；否則改明天。
 * - 星期五、15 號、12 月 1 日：取「下一個」還沒過的那一天。
 * - 今天、這週一等明確日期若已過去，保留原日期，但回傳 warning 讓畫面提醒。
 * @returns {{date: Date|null, warning?: string, adjustment?: string, invalid?: string}}
 */
function resolveDateTime(token, clock, period, now, repeat) {
  const later = (date) => date.getTime() > now.getTime();
  if (!token) {
    let date = withTime(startOfDay(now), clock);
    let adjustment = '';
    if (!later(date)) {
      const afternoon = new Date(date.getTime());
      afternoon.setHours(date.getHours() + 12);
      if (!period && clock.hour >= 1 && clock.hour <= 11 && !clock.nextDay && later(afternoon)) {
        date = afternoon;
        adjustment = `今天上午 ${clock.hour}:${String(clock.minute).padStart(2, '0')} 已過，改為今天${date.getHours() >= 18 ? '晚上' : '下午'} ${formatClock(date)}；若是指明天上午，請修改下方時間。`;
      } else {
        date = withTime(startOfDay(now, 1), clock);
        adjustment = '今天的這個時間已過，改為明天。';
      }
    }
    if (repeat === 'weekdays') {
      while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
    }
    return { date, adjustment };
  }

  const bareWeekday = new RegExp(`^${WEEK_WORD}(${WEEKDAY})$`, 'u').exec(token);
  if (bareWeekday) {
    const target = weekdayNumber(bareWeekday[1]) % 7; // JavaScript：星期日 = 0
    let date = withTime(startOfDay(now, (target - now.getDay() + 7) % 7), clock);
    if (!later(date)) date = withTime(startOfDay(now, (target - now.getDay() + 7) % 7 + 7), clock);
    return { date };
  }

  const monthDate = /^([0-9]{1,2})月([0-9]{1,2})(?:號|日)$/u.exec(token);
  if (monthDate) {
    const [month, day] = [Number(monthDate[1]), Number(monthDate[2])];
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
      const base = new Date(year, month - 1, day);
      if (month < 1 || month > 12 || base.getMonth() !== month - 1 || base.getDate() !== day) continue;
      const date = withTime(base, clock);
      if (later(date)) return { date };
    }
    return { date: null, invalid: `${month} 月 ${day} 日不是有效日期，提醒時間未設定。` };
  }

  const monthDay = /^([0-9]{1,2})(?:號|日)$/u.exec(token);
  if (monthDay) {
    const day = Number(monthDay[1]);
    for (let offset = 0; day >= 1 && day <= 31 && offset <= 2; offset += 1) {
      const base = new Date(now.getFullYear(), now.getMonth() + offset, day);
      if (base.getDate() !== day) continue; // 例如 2 月沒有 30 號
      const date = withTime(base, clock);
      if (later(date)) return { date };
    }
    return { date: null, invalid: `找不到有效的 ${day} 號，提醒時間未設定。` };
  }

  const date = withTime(dateForToken(token, now), clock);
  return {
    date,
    warning: later(date) ? '' : '已經過去了',
  };
}

function maskRecurrence(normalized) {
  const match = RECURRENCE_PATTERN.exec(normalized.text);
  if (!match) return normalized.text;
  const word = match[0];
  let repeat = 'daily';
  let keepFrom = word.length; // 保留給日期規則解析的部分（例如「週1」「15號」）
  if (/1(?:到|至)/u.test(word) || /平日|工作天/u.test(word)) repeat = 'weekdays';
  else if (/^每個?(?:週|禮拜|星期)/u.test(word)) {
    repeat = 'weekly';
    const day = new RegExp(`${WEEK_WORD}${WEEKDAY}$`, 'u').exec(word);
    if (day) keepFrom = day.index;
  } else if (/^每個?月/u.test(word)) {
    repeat = 'monthly';
    const day = /[0-9]{1,2}(?:號|日)$/u.exec(word);
    if (day) keepFrom = day.index;
  } else if (word === '每年') repeat = 'yearly';
  normalized.repeat = repeat;
  normalized.recurrenceSpan = originalSpan(normalized, match.index, match.index + word.length);
  // 用不會被任何規則比對到的字元蓋掉「每、每個、每月」等字，長度不變以維持原文位置對應。
  return normalized.text.slice(0, match.index) + '\u0001'.repeat(keepFrom) + normalized.text.slice(match.index + keepFrom);
}

/** @returns {{title: string, reminderAt: string|null, normalizedText: string, matchedTimeText: string, explanation: string, repeat: string|null, warning: string, adjustment: string}} */
export function parseTaskInput(text, now = new Date()) {
  const normalized = normalizeWithMap(text);
  const value = maskRecurrence(normalized);
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

  let dated = new RegExp(DATE_PATTERN, 'u').exec(value);
  if (dated && !/^(?:今|明|後|下|這|本)/u.test(dated[0])) {
    const reminderIndex = value.indexOf('提醒我');
    const clockIndex = value.search(new RegExp(CLOCK_PATTERN, 'u'));
    const boundary = reminderIndex >= 0 ? reminderIndex : clockIndex >= 0 ? clockIndex : value.length;
    if (dated.index >= boundary) dated = null;
  }
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
    const time = new RegExp(`(?<![0-9:月])(${PERIOD_PATTERN})?(${CLOCK_PATTERN})(?![0-9:])`, 'u').exec(value);
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
  if (!parsedClock || !validOriginalNumber(normalized, start, length) || value[start + length] === ':') {
    return result(normalized, start, length, null, '時間格式不合法，提醒時間未設定。', [sleepSpan]);
  }
  const resolved = resolveDateTime(dateToken, parsedClock, period, now, normalized.repeat);
  if (!resolved.date) return result(normalized, start, length, null, resolved.invalid, [sleepSpan]);
  const parsed = result(normalized, start, length, resolved.date.toISOString(), resolved.adjustment || '已依裝置本機時區設定提醒時間。', [sleepSpan]);
  parsed.warning = resolved.warning ? `注意：「${parsed.matchedTimeText}」已經過去了。請確認日期，或在下方修改開始時間。` : '';
  parsed.adjustment = resolved.adjustment || '';
  return parsed;
}
