export const MAX_ATTACHMENTS_PER_TASK = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_DB_NAME = 'voice-task-reminder.attachments.v1';
const STORE_NAME = 'files';

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx']);

function extension(name) {
  return String(name ?? '').toLowerCase().split('.').pop() || '';
}

function fileKind(file) {
  return String(file?.type ?? '').startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension(file?.name))
    ? 'image' : 'file';
}

export function sanitizeAttachmentName(name) {
  return String(name ?? '附件')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 120) || '附件';
}

export function validateAttachment(file) {
  if (!file || typeof file !== 'object') return { ok: false, error: '附件無法讀取。' };
  const name = sanitizeAttachmentName(file.name);
  const type = String(file.type ?? '').toLowerCase();
  const ext = extension(name);
  if (!ALLOWED_TYPES.has(type) && !ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: '不支援此附件類型；可用圖片、PDF、TXT、CSV、Word 或 Excel。' };
  }
  const size = Number(file.size);
  const limit = fileKind(file) === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: '附件大小無效。' };
  if (size > limit) return { ok: false, error: `${fileKind(file) === 'image' ? '圖片' : '檔案'}不可超過 ${limit / 1024 / 1024} MB。` };
  return {
    ok: true,
    metadata: {
      id: globalThis.crypto?.randomUUID?.() || `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      type: type || 'application/octet-stream',
      size,
      kind: fileKind(file),
      createdAt: new Date().toISOString(),
    },
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('此瀏覽器不支援本機附件儲存。'));
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(ATTACHMENT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('無法開啟本機附件儲存。'));
  });
}

export async function saveAttachment(taskId, metadata, file) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completion = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('附件儲存失敗。'));
      transaction.onabort = () => reject(transaction.error || new Error('附件儲存已取消。'));
    });
    await requestToPromise(transaction.objectStore(STORE_NAME).put({ ...metadata, taskId, blob: file }));
    await completion;
  } finally {
    database.close();
  }
}

export async function saveAttachmentBatch(taskId, drafts, writer = saveAttachment, remover = deleteAttachments) {
  const storedIds = [];
  try {
    for (const draft of drafts || []) {
      await writer(taskId, draft.metadata, draft.file);
      storedIds.push(draft.metadata.id);
    }
    return storedIds;
  } catch (error) {
    await remover(storedIds).catch(() => {});
    throw error;
  }
}

export async function getAttachment(id) {
  const database = await openDatabase();
  try {
    return await requestToPromise(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id));
  } finally {
    database.close();
  }
}

export async function deleteAttachment(id) {
  const database = await openDatabase();
  try {
    await requestToPromise(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id));
  } finally {
    database.close();
  }
}

export async function listAttachments() {
  const database = await openDatabase();
  try {
    return await requestToPromise(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll());
  } finally {
    database.close();
  }
}

export async function deleteAttachments(ids) {
  const uniqueIds = [...new Set((ids || []).filter(id => typeof id === 'string' && id))];
  if (!uniqueIds.length) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completion = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('附件清理失敗。'));
      transaction.onabort = () => reject(transaction.error || new Error('附件清理已取消。'));
    });
    const store = transaction.objectStore(STORE_NAME);
    uniqueIds.forEach(id => store.delete(id));
    await completion;
  } finally {
    database.close();
  }
}
