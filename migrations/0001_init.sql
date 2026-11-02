-- Bookkeeping tables the Worker entry needs. Times are epoch ms UTC.
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY,
  cron TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
