import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, comboKey, type Item } from './engine.ts';

const item = (id: number, category: Item['category'], formality: number, colors: string[], occasions: string[] = [], style = 'western'): Item =>
  ({ id, name: `#${id}`, category, formality, colors, occasions, seasons: [], style });

const wardrobe = [
  item(1, 'top', 5, ['maroon'], ['wedding'], 'ethnic'),       // sherwani-ish kurta
  item(2, 'bottom', 5, ['cream'], ['wedding'], 'ethnic'),
  item(3, 'top', 2, ['red'], ['casual']),                        // t-shirt
  item(4, 'bottom', 2, ['blue'], ['casual']),                    // jeans
  item(5, 'top', 4, ['white'], ['party']),
  item(6, 'footwear', 5, ['brown'], ['wedding'], 'ethnic'),
  item(7, 'one_piece', 1, ['green', 'pink', 'yellow'], ['gym']),
];

test('wedding picks the formal ethnic outfit first', () => {
  const [best] = recommend(wardrobe, { occasion: 'Wedding reception in Surat' }, new Map(), new Set());
  assert.deepEqual(best.items.map((i) => i.id).sort(), [1, 2, 6]);
});

test('returns distinct main pieces and respects count', () => {
  const outfits = recommend(wardrobe, { occasion: 'casual', count: 3 }, new Map(), new Set());
  assert.equal(outfits.length, 3);
  const mains = outfits.flatMap((o) => o.items.filter((i) => i.category === 'top' || i.category === 'one_piece').map((i) => i.id));
  assert.equal(new Set(mains).size, mains.length);
});

test('skips a combo worn recently and penalises recent items', () => {
  const recent = new Set([comboKey([{ id: 1 }, { id: 2 }])]);
  const outfits = recommend(wardrobe, { occasion: 'wedding' }, new Map([[1, 0], [2, 0]]), recent);
  assert.ok(outfits.every((o) => comboKey(o.items.filter((i) => i.category !== 'footwear')) !== '1,2'));
});
