PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS streamflow_sessions (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  episode_name TEXT NOT NULL DEFAULT '',
  line_index INTEGER NOT NULL DEFAULT 0,
  episode_index INTEGER NOT NULL DEFAULT 0,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  target_start_seconds REAL NOT NULL DEFAULT 0,
  target_end_seconds REAL NOT NULL DEFAULT 0,
  cached_start_seconds REAL NOT NULL DEFAULT 0,
  cached_end_seconds REAL NOT NULL DEFAULT 0,
  cached_bytes INTEGER NOT NULL DEFAULT 0,
  cached_objects INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  playback_state TEXT NOT NULL DEFAULT 'idle',
  cache_state TEXT NOT NULL DEFAULT 'idle',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_heartbeat INTEGER NOT NULL DEFAULT 0,
  last_queued_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streamflow_sessions_updated ON streamflow_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_streamflow_sessions_item ON streamflow_sessions(item_key, episode_index);

CREATE TABLE IF NOT EXISTS streamflow_objects (
  session_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'segment',
  track_id TEXT NOT NULL DEFAULT 'main',
  start_seconds REAL NOT NULL DEFAULT 0,
  end_seconds REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  range_header TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, object_id),
  FOREIGN KEY (session_id) REFERENCES streamflow_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_streamflow_objects_session_time ON streamflow_objects(session_id, end_seconds);
CREATE INDEX IF NOT EXISTS idx_streamflow_objects_created ON streamflow_objects(created_at);

CREATE TABLE IF NOT EXISTS streamflow_hints (
  session_id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL DEFAULT 'main',
  playlist_url TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streamflow_hints_updated ON streamflow_hints(updated_at);
