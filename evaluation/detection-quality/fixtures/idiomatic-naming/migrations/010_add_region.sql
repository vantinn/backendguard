-- INSECURE: multi-line statements that a line-based scan misses.
ALTER TABLE orders
  ADD COLUMN region varchar(8) NOT NULL;

UPDATE orders
  SET region = 'us';
