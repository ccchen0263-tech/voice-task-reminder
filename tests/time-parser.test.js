import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, parseTaskInput } from '../js/time-parser.js';

// 固定本機日期，測試不依賴 UTC 或執行機器的時區。
const now = new Date(2026, 9, 14, 10, 20, 30); // 星期三
const localISO = (year, month, day, hour, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();
const afterMinutes = (minutes, base = now) => new Date(base.getTime() + minutes * 60_000).toISOString();

const requiredCases = [
  ['10分鐘後提醒我喝水', '喝水', afterMinutes(10)],
  ['十分鐘後提醒我喝水', '喝水', afterMinutes(10)],
  ['半小時後提醒我出門', '出門', afterMinutes(30)],
  ['一個小時後提醒我打電話', '打電話', afterMinutes(60)],
  ['一個半小時後提醒我開會', '開會', afterMinutes(90)],
  ['兩小時後提醒我回覆客戶', '回覆客戶', afterMinutes(120)],
  ['今天下午三點提醒我回覆客戶', '回覆客戶', localISO(2026, 10, 14, 15)],
  ['今天下午三點半提醒我回覆客戶', '回覆客戶', localISO(2026, 10, 14, 15, 30)],
  ['明天早上八點提醒我買早餐', '買早餐', localISO(2026, 10, 15, 8)],
  ['明早八點提醒我買早餐', '買早餐', localISO(2026, 10, 15, 8)],
  ['明早提醒我買早餐', '買早餐', localISO(2026, 10, 15, 8)],
  ['明晚提醒我運動', '運動', localISO(2026, 10, 15, 19)],
  ['下週一早上九點提醒我開會', '開會', localISO(2026, 10, 19, 9)],
  ['這禮拜五下午三點提醒我交報告', '交報告', localISO(2026, 10, 16, 15)],
  ['等一下提醒我喝水', '喝水', afterMinutes(10)],
  ['待會提醒我喝水', '喝水', afterMinutes(10)],
  ['晚一點提醒我回訊息', '回訊息', afterMinutes(60)],
  ['睡前提醒我吃藥', '吃藥', null],
];

for (const [input, title, expected] of requiredCases) {
  test(`必填句子：${input}`, () => {
    const parsed = parseTaskInput(input, now);
    assert.equal(parsed.title, title);
    assert.equal(parsed.reminderAt, expected);
    assert.ok(parsed.matchedTimeText);
    assert.equal(typeof parsed.explanation, 'string');
  });
}

test('正規化：中文數字、全形數字、空白標點及單位同義詞', () => {
  assert.equal(normalizeText(' 今天 下午 三點鐘，提醒我 喝水！ '), '今天下午3點提醒我喝水');
  assert.equal(normalizeText('一、兩、二、三、十、十五、二十、三十、一百二十三'), '122310152030123');
  assert.equal(normalizeText('１０ 分後；一個小時後；兩鐘頭後；十五时'), '10分鐘後1小時後2小時後15时');
  assert.equal(normalizeText('三点十五分'), '3點15分鐘');
  assert.equal(normalizeText('8：30'), '8:30');
  assert.equal(normalizeText('10分鐘'), '10分鐘');
  assert.equal(normalizeText('一 個 小 時 後'), '1小時後');
  assert.equal(normalizeText('二 十 分 後'), '20分鐘後');
});

test('原始任務保留中文數字、標點與 meaningful text', () => {
  const parsed = parseTaskInput('今天 下午 三 點 半，提醒我喝兩杯水、買三份早餐', now);
  assert.equal(parsed.title, '喝兩杯水、買三份早餐');
  assert.equal(parsed.reminderAt, localISO(2026, 10, 14, 15, 30));
  assert.equal(parsed.matchedTimeText, '今天 下午 三 點 半');
});

test('時間與提醒我中間有空白或標點時，完整移除並保留任務原字', () => {
  const spaced = parseTaskInput('10 分鐘後 提醒 我 喝一杯水', now);
  assert.equal(spaced.title, '喝一杯水');
  assert.equal(spaced.reminderAt, afterMinutes(10));
  const tomorrow = parseTaskInput('明 早 八 點，提醒我買早餐', now);
  assert.equal(tomorrow.title, '買早餐');
  assert.equal(tomorrow.reminderAt, localISO(2026, 10, 15, 8));
  const punctuated = parseTaskInput('十 分鐘後，提 醒、我：喝兩杯水、買三份早餐', now);
  assert.equal(punctuated.title, '喝兩杯水、買三份早餐');
  assert.equal(punctuated.reminderAt, afterMinutes(10));
  assert.equal(parseTaskInput('提 醒 我 買一份早餐', now).title, '買一份早餐');
});

test('全形輸入與分鐘時刻', () => {
  assert.equal(parseTaskInput('明天早上８：３０提醒我買早餐', now).reminderAt, localISO(2026, 10, 15, 8, 30));
  assert.equal(parseTaskInput('今天下午三點十五分提醒我打電話', now).reminderAt, localISO(2026, 10, 14, 15, 15));
  assert.equal(parseTaskInput('今天下午十五點三十分提醒我打電話', now).reminderAt, localISO(2026, 10, 14, 15, 30));
  assert.equal(parseTaskInput('8:30提醒我吃早餐', now).reminderAt, localISO(2026, 10, 14, 8, 30));
});

test('相對時間變體', () => {
  for (const input of ['一小時半後提醒我開會', '1個半小時後提醒我開會', '1鐘頭半後提醒我開會', '1個半鐘頭後提醒我開會', '1小時30分鐘後提醒我開會']) {
    assert.equal(parseTaskInput(input, now).reminderAt, afterMinutes(90), input);
  }
  assert.equal(parseTaskInput('零分鐘後提醒我喝水', now).reminderAt, now.toISOString());
});

test('下午與上午 12 點、午夜與晚上 12 點', () => {
  assert.equal(parseTaskInput('今天下午十二點提醒我吃飯', now).reminderAt, localISO(2026, 10, 14, 12));
  assert.equal(parseTaskInput('今天上午十二點提醒我查資料', now).reminderAt, localISO(2026, 10, 14, 0));
  assert.equal(parseTaskInput('明天午夜十二點提醒我查資料', now).reminderAt, localISO(2026, 10, 15, 0));
  assert.equal(parseTaskInput('今天晚上十二點提醒我休息', now).reminderAt, localISO(2026, 10, 15, 0));
  assert.equal(parseTaskInput('明晚十二點提醒我休息', now).reminderAt, localISO(2026, 10, 16, 0));
  assert.equal(parseTaskInput('明晚一點提醒我休息', now).reminderAt, localISO(2026, 10, 15, 13));
  assert.equal(parseTaskInput('今天晚一點提醒我休息', now).reminderAt, localISO(2026, 10, 14, 13));
  assert.equal(parseTaskInput('12點提醒我吃饭', now).reminderAt, localISO(2026, 10, 14, 12));
});

test('今天已過時間與本週已過日期仍保留，不擅自改成明天或下週', () => {
  assert.equal(parseTaskInput('今天早上八點提醒我開會', now).reminderAt, localISO(2026, 10, 14, 8));
  assert.equal(parseTaskInput('這禮拜一早上九點提醒我開會', now).reminderAt, localISO(2026, 10, 12, 9));
});

test('星期同義詞、本週一為起點與週日邊界', () => {
  assert.equal(parseTaskInput('下周一早上九點提醒我開會', now).reminderAt, localISO(2026, 10, 19, 9));
  assert.equal(parseTaskInput('這星期天早上九點提醒我開會', now).reminderAt, localISO(2026, 10, 18, 9));
  assert.equal(parseTaskInput('本週日早上九點提醒我開會', now).reminderAt, localISO(2026, 10, 18, 9));
  const sunday = new Date(2026, 9, 18, 20);
  assert.equal(parseTaskInput('下週一早上九點提醒我開會', sunday).reminderAt, localISO(2026, 10, 19, 9));
  assert.equal(parseTaskInput('這週一早上九點提醒我開會', sunday).reminderAt, localISO(2026, 10, 12, 9));
});

test('跨年、跨月與閏年', () => {
  const yearEnd = new Date(2026, 11, 31, 23, 50);
  assert.equal(parseTaskInput('20分鐘後提醒我喝水', yearEnd).reminderAt, afterMinutes(20, yearEnd));
  assert.equal(parseTaskInput('明早提醒我買早餐', yearEnd).reminderAt, localISO(2027, 1, 1, 8));
  const monthEnd = new Date(2026, 0, 31, 23, 30);
  assert.equal(parseTaskInput('一小時後提醒我出門', monthEnd).reminderAt, afterMinutes(60, monthEnd));
  const leapDay = new Date(2028, 1, 28, 10);
  assert.equal(parseTaskInput('明天早上八點提醒我買早餐', leapDay).reminderAt, localISO(2028, 2, 29, 8));
  const yearSunday = new Date(2026, 11, 27, 10);
  assert.equal(parseTaskInput('下週五下午三點提醒我交報告', yearSunday).reminderAt, localISO(2027, 1, 1, 15));
});

test('非法鐘點、分鐘、負數、小數與未知日期不能亂猜', () => {
  const inputs = [
    '今天下午二十五點提醒我喝水', '明早24點提醒我買早餐',
    '今天下午三點九十分提醒我打電話', '今天25:10提醒我開會',
    '明天8:60提醒我開會', '今天上午十三點提醒我開會',
    '-1小時後提醒我開會', '1.5小時後提醒我開會',
    '下個月三點提醒我開會', '下下週一九點提醒我開會',
    '這禮拜八下午三點提醒我開會', '明年三點提醒我開會',
    '昨天早上八點提醒我開會', '12月1日8點提醒我開會',
    '下週下午三點提醒我開會', '星期一下午三點提醒我開會',
    '今天8:30:40提醒我開會', '明早8:30:45提醒我買早餐',
    '明早3.5點提醒我買早餐',
  ];
  for (const input of inputs) assert.equal(parseTaskInput(input, now).reminderAt, null, input);
});

test('任務內的月份數字不應影響前方已辨識的時間', () => {
  const parsed = parseTaskInput('今天下午三點提醒我交五月報告', now);
  assert.equal(parsed.title, '交五月報告');
  assert.equal(parsed.reminderAt, localISO(2026, 10, 14, 15));
});

test('無時間、日期但無鐘點與睡前保留未設定', () => {
  assert.equal(parseTaskInput('買兩份早餐', now).title, '買兩份早餐');
  assert.equal(parseTaskInput('買兩份早餐', now).reminderAt, null);
  assert.equal(parseTaskInput('明天提醒我買早餐', now).reminderAt, null);
  assert.equal(parseTaskInput('今晚睡前提醒我吃藥', now).title, '吃藥');
  assert.equal(parseTaskInput('明晚睡前提醒我吃藥', now).reminderAt, null);
  assert.equal(parseTaskInput('', now).reminderAt, null);
  assert.equal(parseTaskInput('喝水', new Date('invalid')).reminderAt, null);
});
