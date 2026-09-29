CREATE TABLE IF NOT EXISTS licenses (
  serial      INTEGER PRIMARY KEY,
  tier        TEXT NOT NULL,
  max_devices INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'   -- active | revoked
);

CREATE TABLE IF NOT EXISTS activations (
  serial        INTEGER NOT NULL,
  device        TEXT NOT NULL,
  device_name   TEXT,
  platform      TEXT,
  activation_id TEXT NOT NULL,
  activated_at  TEXT NOT NULL,
  PRIMARY KEY (serial, device)
);
