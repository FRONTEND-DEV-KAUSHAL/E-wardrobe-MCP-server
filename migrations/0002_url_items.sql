-- Items added from a web link instead of Drive. For these, drive_file_id holds 'url:<source_url>'
-- (keeps the NOT NULL UNIQUE column, dedupes re-adds, and avoids a table rebuild that would cascade-delete wear history).
ALTER TABLE clothing_items ADD COLUMN image_url TEXT;
ALTER TABLE clothing_items ADD COLUMN source_url TEXT;
