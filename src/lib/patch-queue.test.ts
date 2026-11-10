import { describe, expect, it } from 'vitest';
import { createPatchQueue } from './patch-queue';

describe('createPatchQueue', () => {
  it('merges partial patches under one key so no edit is dropped', () => {
    const q = createPatchQueue();
    q.add('line-1', { one_time_price: 500 });
    q.add('line-1', { one_time_label: 'Setup' });
    expect(q.take('line-1')).toEqual({ one_time_price: 500, one_time_label: 'Setup' });
  });

  it('lets a later value for the same field win', () => {
    const q = createPatchQueue();
    q.add('discount', { discount_type: 'percent', discount_value: 5 });
    q.add('discount', { discount_value: 10 });
    expect(q.take('discount')).toEqual({ discount_type: 'percent', discount_value: 10 });
  });

  it('keeps keys apart and empties a key once taken', () => {
    const q = createPatchQueue();
    q.add('line-1', { display_order: 20 });
    q.add('line-2', { display_order: 10 });
    expect(q.take('line-1')).toEqual({ display_order: 20 });
    expect(q.take('line-1')).toBeUndefined();
    expect(q.take('line-2')).toEqual({ display_order: 10 });
  });

  it('drops a key', () => {
    const q = createPatchQueue();
    q.add('line-1', { name: 'x' });
    q.drop('line-1');
    expect(q.take('line-1')).toBeUndefined();
  });
});
