import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, sanitizeAttachmentName, saveAttachmentBatch, validateAttachment } from '../js/attachment-store.js';

test('attachment validation allows safe image and document types with separate limits', () => {
  const image = validateAttachment({ name: '照片.png', type: 'image/png', size: 1024 });
  assert.equal(image.ok, true);
  assert.equal(image.metadata.kind, 'image');
  assert.equal(validateAttachment({ name: 'large.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }).ok, false);
  assert.equal(validateAttachment({ name: 'brief.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES }).ok, true);
  assert.equal(validateAttachment({ name: 'too-large.pdf', type: 'application/pdf', size: MAX_ATTACHMENT_BYTES + 1 }).ok, false);
});

test('attachment validation rejects executable types and sanitizes display names', () => {
  assert.equal(validateAttachment({ name: 'run.exe', type: 'application/x-msdownload', size: 10 }).ok, false);
  assert.equal(validateAttachment({ name: 'vector.svg', type: 'image/svg+xml', size: 10 }).ok, false);
  assert.equal(validateAttachment({ name: 'page.html', type: 'text/html', size: 10 }).ok, false);
  assert.equal(sanitizeAttachmentName('../secret<script>.pdf'), '.._secret_script_.pdf');
  assert.equal(sanitizeAttachmentName('" onerror="alert(1).pdf').includes('<'), false);
});

test('attachment batch rolls back partial writes before the task can be committed', async () => {
  const removed = [];
  const drafts = [
    { metadata: { id: 'first' }, file: {} },
    { metadata: { id: 'second' }, file: {} },
  ];
  await assert.rejects(saveAttachmentBatch('task-1', drafts, async (_taskId, metadata) => {
    if (metadata.id === 'second') throw new Error('quota');
  }, async ids => removed.push(...ids)), /quota/);
  assert.deepEqual(removed, ['first']);
});
