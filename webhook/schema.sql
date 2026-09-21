-- WhatsApp Business Bot Database Schema
-- SQLite3

-- Phone number registry (maksimum 40)
CREATE TABLE IF NOT EXISTS phone_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  active BOOLEAN DEFAULT 1
);

-- Conversations (sessions)
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  phone_number_id INTEGER REFERENCES phone_numbers(id),
  started_at DATETIME DEFAULT (datetime('now')),
  ended_at DATETIME,
  message_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed'))
);

-- Messages
-- Untuk media messages (image/audio/video):
--   - message_type = 'image' | 'audio' | 'video' | 'document'
--   - media_id = WhatsApp Media ID (guna untuk download dari API)
--   - media_url = path file lokal kalau dah di-download
--   - mime_type = MIME type (image/jpeg, audio/ogg, etc)
--   - file_size = saiz dalam bytes
--   - filename = nama fail asal (utk document)
--   - caption = kapsyen utk image/video
--   - content = text body (utk text message) atau description
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id),
  wa_id TEXT NOT NULL,
  message_id TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT,
  -- Media fields
  media_id TEXT,
  media_url TEXT,
  mime_type TEXT,
  file_size INTEGER,
  filename TEXT,
  caption TEXT,
  -- Location
  latitude REAL,
  longitude REAL,
  -- Context (reply to)
  context_message_id TEXT,
  -- Raw JSON payload
  metadata TEXT,
  -- Timestamps
  created_at DATETIME DEFAULT (datetime('now')),
  processed BOOLEAN DEFAULT 0
);

-- Daily usage tracking
CREATE TABLE IF NOT EXISTS daily_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT (date('now')),  -- YYYY-MM-DD
  conversation_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  UNIQUE(wa_id, date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed, direction);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_wa_id ON conversations(wa_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_daily_usage_wa_id ON daily_usage(wa_id);
CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_active ON phone_numbers(active);
