import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyClaimState, mergeBatch, claimStorePath, sortByTakenDesc } from './claim.ts';

test('空状态', () => {
  const s = emptyClaimState();
  assert.deepEqual(s.photos, []);
  assert.equal(s.lastBatchId, 0);
});

test('合并一批 URI 会自增 batchId 并保留顺序', () => {
  let s = emptyClaimState();
  s = mergeBatch(s, ['u1', 'u2'], 1000);
  assert.equal(s.photos.length, 2);
  assert.equal(s.photos[0].photoId, 'u1');
  assert.equal(s.photos[0].batchId, 1);
  assert.equal(s.photos[0].claimedAt, 1000);
  assert.equal(s.photos[0].takenAt, 0);   // EXIF 稍后回填（Task 9）
  assert.equal(s.lastBatchId, 1);
});

test('重复认领同一 URI 不产生重复项', () => {
  let s = emptyClaimState();
  s = mergeBatch(s, ['u1', 'u2'], 1000);
  s = mergeBatch(s, ['u2', 'u3'], 2000);
  assert.equal(s.photos.length, 3);
  assert.deepEqual(s.photos.map(p => p.photoId), ['u1', 'u2', 'u3']);
  assert.equal(s.lastBatchId, 2);
});

test('空 URI 被忽略', () => {
  const s = mergeBatch(emptyClaimState(), ['u1', '', 'u2'], 1);
  assert.equal(s.photos.length, 2);
});

test('claimStorePath 拼出固定文件名', () => {
  assert.equal(claimStorePath('/x').endsWith('claimed_photos.json'), true);
});

test('sortByTakenDesc：有拍摄时间的按时间倒序，无时间的排最后', () => {
  const photos = [
    { photoId: 'a', batchId: 1, claimedAt: 1, takenAt: 100 },
    { photoId: 'b', batchId: 1, claimedAt: 1, takenAt: 0 },
    { photoId: 'c', batchId: 1, claimedAt: 1, takenAt: 300 }
  ];
  const sorted = sortByTakenDesc(photos);
  assert.deepEqual(sorted.map(p => p.photoId), ['c', 'a', 'b']);
});
