import { createHash } from 'node:crypto';

// Older API clients can omit a key. New clients keep one key for the same
// submission until the server confirms which job owns it.
export function submissionKey(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw Object.assign(new Error('invalid idempotencyKey'), { code: 400 });
  }
  return value;
}

export function submissionHash(fields) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
