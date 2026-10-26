-- List-valued columns (colors, occasions, seasons) hold JSON arrays of lowercase strings.
CREATE TABLE clothing_items (
  id INTEGER PRIMARY KEY,
  drive_file_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  drive_folder TEXT,
  name TEXT,
  category TEXT CHECK (category IN ('top', 'bottom', 'one_piece', 'outerwear', 'footwear', 'accessory')),
  subcategory TEXT,
  colors TEXT NOT NULL DEFAULT '[]',
  pattern TEXT,
  fabric TEXT,
  fit TEXT,
  style TEXT,
  formality INTEGER CHECK (formality BETWEEN 1 AND 5),
  occasions TEXT NOT NULL DEFAULT '[]',
  seasons TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE outfits (
  id INTEGER PRIMARY KEY,
  name TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE outfit_items (
  outfit_id INTEGER NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES clothing_items(id) ON DELETE CASCADE,
  PRIMARY KEY (outfit_id, item_id)
);

CREATE TABLE wear_history (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES clothing_items(id) ON DELETE CASCADE,
  outfit_id INTEGER REFERENCES outfits(id) ON DELETE SET NULL,
  worn_on TEXT NOT NULL,
  occasion TEXT
);

CREATE INDEX wear_history_item ON wear_history(item_id, worn_on);
