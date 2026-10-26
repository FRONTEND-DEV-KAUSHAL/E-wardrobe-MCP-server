// Outfit recommendation: plain scoring, no AI calls. Kept cheap for the Workers CPU budget.

export type Category = 'top' | 'bottom' | 'one_piece' | 'outerwear' | 'footwear' | 'accessory';

export interface Item {
  id: number;
  name: string | null;
  category: Category | null;
  colors: string[];
  formality: number | null;
  occasions: string[];
  seasons: string[];
  style: string | null;
}

export interface OutfitRequest {
  occasion?: string;
  formality?: number; // 1 = gym/lounge … 5 = wedding/black tie
  season?: string;
  temperatureC?: number;
  count?: number;
}

export interface Outfit {
  items: Item[];
  score: number;
  reasons: string[];
}

// ponytail: keyword map, let the client pass `formality` for anything it misses
const OCCASION_FORMALITY: Record<string, number> = {
  gym: 1, lounge: 1, home: 1,
  casual: 2, travel: 2, college: 2, outing: 2,
  date: 3, office: 3, work: 3, dinner: 3, festival: 4,
  party: 4, interview: 4, puja: 4, reception: 5, wedding: 5, 'black tie': 5,
};

const NEUTRALS = new Set(['black', 'white', 'grey', 'gray', 'navy', 'beige', 'cream', 'off-white', 'brown', 'khaki', 'tan', 'denim', 'charcoal', 'olive']);

export function targetFormality(req: OutfitRequest): number | undefined {
  if (req.formality) return req.formality;
  const occ = req.occasion?.toLowerCase() ?? '';
  for (const [key, value] of Object.entries(OCCASION_FORMALITY)) if (occ.includes(key)) return value;
}

/** recentlyWorn: item id -> days since last worn. recentCombos: sorted item-id keys of outfits worn recently. */
export function recommend(items: Item[], req: OutfitRequest, recentlyWorn: Map<number, number>, recentCombos: Set<string>): Outfit[] {
  const formality = targetFormality(req);
  const occasion = req.occasion?.toLowerCase();
  const season = req.season?.toLowerCase();

  const itemScore = (item: Item, why: string[]): number => {
    let s = 0;
    const label = item.name ?? `item ${item.id}`;
    const tag = occasion && item.occasions.find((o) => occasion.includes(o) || o.includes(occasion));
    if (tag) { s += 3; why.push(`${label} is tagged '${tag}'`); }
    if (formality && item.formality) s -= Math.abs(item.formality - formality) * 1.5;
    if (season && item.seasons.length && !item.seasons.includes(season) && !item.seasons.includes('all')) s -= 2;
    const days = recentlyWorn.get(item.id);
    if (days !== undefined) { s -= Math.max(0, 4 - days / 2); }
    return s;
  };

  // Rank each slot independently, keep the best few to bound the combo count.
  const slot = (cat: Category, n: number) =>
    items.filter((i) => i.category === cat)
      .map((item) => ({ item, s: itemScore(item, []) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.item);

  const tops = slot('top', 8), bottoms = slot('bottom', 8), onePieces = slot('one_piece', 8);
  const shoes = slot('footwear', 4), layers = slot('outerwear', 3);
  const cold = req.temperatureC !== undefined ? req.temperatureC < 18 : season === 'winter';

  const bases: Item[][] = [...onePieces.map((o) => [o])];
  for (const t of tops) for (const b of bottoms) bases.push([t, b]);

  const candidates: Outfit[] = [];
  for (const base of bases) {
    for (const shoe of shoes.length ? shoes : [undefined]) {
      for (const layer of cold && layers.length ? layers : [undefined]) {
        const outfitItems = [...base, layer, shoe].filter((i): i is Item => !!i);
        if (recentCombos.has(comboKey(outfitItems)) || recentCombos.has(comboKey(base))) continue;
        const reasons: string[] = [];
        let score = outfitItems.reduce((sum, i) => sum + itemScore(i, reasons), 0);

        const bold = new Set(outfitItems.flatMap((i) => i.colors).filter((c) => !NEUTRALS.has(c)));
        if (bold.size <= 1) { score += 2; reasons.push(bold.size ? `one accent colour (${[...bold][0]}) on neutrals` : 'all-neutral palette'); }
        else if (bold.size === 2) score += 1;
        else { score -= 1.5; reasons.push(`busy palette (${[...bold].join(', ')})`); }

        const levels = outfitItems.map((i) => i.formality).filter((f): f is number => f !== null);
        if (levels.length > 1 && Math.max(...levels) - Math.min(...levels) >= 3) { score -= 2; reasons.push('formality of pieces is mismatched'); }

        const styles = new Set(outfitItems.map((i) => i.style).filter(Boolean));
        if (styles.size === 1 && outfitItems.length > 1) { score += 1; reasons.push(`consistent ${[...styles][0]} style`); }

        const worn = outfitItems.filter((i) => recentlyWorn.has(i.id));
        if (worn.length) reasons.push(`includes recently worn: ${worn.map((i) => i.name ?? i.id).join(', ')}`);
        if (layer) reasons.push(`added ${layer.name ?? 'a layer'} for the cold`);

        candidates.push({ items: outfitItems, score: Math.round(score * 10) / 10, reasons });
      }
    }
  }

  // Greedy pick for variety: don't reuse a main piece across the returned outfits.
  candidates.sort((a, b) => b.score - a.score);
  const picked: Outfit[] = [];
  const used = new Set<number>();
  for (const c of candidates) {
    const mains = c.items.filter((i) => i.category === 'top' || i.category === 'one_piece');
    if (mains.some((i) => used.has(i.id))) continue;
    mains.forEach((i) => used.add(i.id));
    picked.push(c);
    if (picked.length === (req.count ?? 3)) break;
  }
  return picked;
}

export const comboKey = (items: { id: number }[]) => items.map((i) => i.id).sort((a, b) => a - b).join(',');
