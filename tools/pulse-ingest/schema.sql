-- Laika Orbit adoption pulse — D1 schema.
--
-- What is deliberately NOT here: no IP address, no user agent, no hostname, no file path, no
-- search query, no account, no email, no precise timestamp. An install is a random id the app
-- generated on the user's machine and that the user chose to send; nothing in this database can
-- be traced back to a person, and the app never sends anything that could.
--
-- Days, not timestamps: an event is counted into a UTC day. That is enough to draw adoption and
-- coarse enough that a single install's activity cannot be used as a fingerprint of when someone
-- is at their desk.

CREATE TABLE IF NOT EXISTS installs (
  install    TEXT PRIMARY KEY,          -- random uuid from the client, the only identifier
  first_day  TEXT NOT NULL,             -- yyyy-mm-dd, UTC
  last_day   TEXT NOT NULL,
  app        TEXT,                      -- app version, e.g. "0.42"
  platform   TEXT,                      -- darwin | linux | win32
  region     TEXT                       -- two-letter continent from CF, never a country or city
);

CREATE TABLE IF NOT EXISTS events (
  install    TEXT NOT NULL,
  day        TEXT NOT NULL,
  name       TEXT NOT NULL,             -- from the worker's allowlist, nothing else is stored
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install, day, name)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS events_day  ON events (day);
CREATE INDEX IF NOT EXISTS events_name ON events (name, day);
CREATE INDEX IF NOT EXISTS installs_day ON installs (first_day);

-- One row per install per day, so a batch that arrives twice (a retry, a flaky network) settles
-- to the same numbers instead of inflating them: the client sends running daily counts and the
-- worker takes the larger of the two.

-- page views on laikaorbit.com: a daily count per (path, referrer host, country), no ids, no IPs
CREATE TABLE IF NOT EXISTS hits (
  day        TEXT NOT NULL,             -- yyyy-mm-dd, UTC
  path       TEXT NOT NULL,             -- the page, without query or fragment
  ref        TEXT NOT NULL DEFAULT '',  -- referring host only, '' for direct or internal
  country    TEXT NOT NULL DEFAULT '',  -- two-letter code from Cloudflare, '' if unknown
  views      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, ref, country)
) WITHOUT ROWID;
