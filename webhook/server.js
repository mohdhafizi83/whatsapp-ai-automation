const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3001;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
if (!VERIFY_TOKEN) {
  console.error('FATAL: VERIFY_TOKEN env var is required (fail-closed). See .env.example');
  process.exit(1);
}
const DB_PATH = path.join(__dirname, 'whatsapp.db');
const MAX_PHONE_NUMBERS = 40;
const MAX_CONVERSATIONS_PER_DAY = 25;

// WhatsApp API config for read receipts
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WHATSAPP_API = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

// Media download directory
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log(`   Media dir: ${MEDIA_DIR}`);
}

// ===== DATABASE SETUP =====
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Prepared statements (compile sekali, guna banyak kali)
const stmts = {
  // Phone numbers
  upsertPhone: db.prepare(`
    INSERT INTO phone_numbers (wa_id, name) 
    VALUES (@wa_id, @name)
    ON CONFLICT(wa_id) DO UPDATE SET name = COALESCE(@name, phone_numbers.name)
  `),
  countActivePhones: db.prepare(
    `SELECT COUNT(*) as count FROM phone_numbers WHERE active = 1`
  ),

  // Conversations
  getActiveConversation: db.prepare(`
    SELECT id, message_count FROM conversations 
    WHERE wa_id = @wa_id AND status = 'active' 
    ORDER BY started_at DESC LIMIT 1
  `),
  createConversation: db.prepare(`
    INSERT INTO conversations (wa_id, phone_number_id) 
    VALUES (@wa_id, @phone_number_id)
  `),
  incrementMessageCount: db.prepare(`
    UPDATE conversations SET message_count = message_count + 1 
    WHERE id = @id
  `),
  closeOldConversations: db.prepare(`
    UPDATE conversations SET status = 'closed', ended_at = datetime('now')
    WHERE wa_id = @wa_id AND status = 'active' 
    AND id != @keep_id
  `),

  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (
      conversation_id, wa_id, message_id, direction, message_type,
      content, media_id, mime_type, file_size, filename, caption,
      latitude, longitude, context_message_id, metadata
    ) VALUES (
      @conversation_id, @wa_id, @message_id, @direction, @message_type,
      @content, @media_id, @mime_type, @file_size, @filename, @caption,
      @latitude, @longitude, @context_message_id, @metadata
    )
  `),

  // Daily usage
  getDailyUsage: db.prepare(`
    SELECT conversation_count, message_count FROM daily_usage 
    WHERE wa_id = @wa_id AND date = date('now')
  `),
  incrementDailyUsage: db.prepare(`
    INSERT INTO daily_usage (wa_id, conversation_count, message_count)
    VALUES (@wa_id, 1, 1)
    ON CONFLICT(wa_id, date) DO UPDATE SET
      conversation_count = conversation_count + @conv_inc,
      message_count = message_count + @msg_inc
  `),

  // Media
  updateMessageMediaUrl: db.prepare('UPDATE messages SET media_url = ? WHERE id = ?'),
};

// ===== HELPER: Process & store message =====
function storeIncomingMessage(waId, profileName, msg) {
  const msgType = msg.type || 'text';
  let content = '';
  let mediaId = null;
  let mimeType = null;
  let fileSize = null;
  let filename = null;
  let caption = null;
  let latitude = null;
  let longitude = null;
  let contextMsgId = null;

  // Extract fields based on message type
  switch (msgType) {
    case 'text':
      content = msg.text?.body || '';
      break;
    case 'image':
      mediaId = msg.image?.id || null;
      mimeType = msg.image?.mime_type || 'image/jpeg';
      fileSize = msg.image?.sha256 ? null : null; // WhatsApp doesn't send size in webhook
      caption = msg.image?.caption || null;
      content = caption || '[Image]';
      break;
    case 'audio':
      mediaId = msg.audio?.id || null;
      mimeType = msg.audio?.mime_type || 'audio/ogg';
      content = '[Audio]';
      break;
    case 'video':
      mediaId = msg.video?.id || null;
      mimeType = msg.video?.mime_type || 'video/mp4';
      caption = msg.video?.caption || null;
      content = caption || '[Video]';
      break;
    case 'document':
      mediaId = msg.document?.id || null;
      mimeType = msg.document?.mime_type || 'application/octet-stream';
      filename = msg.document?.filename || null;
      caption = msg.document?.caption || null;
      content = caption || `[Document: ${filename || 'unknown'}]`;
      break;
    case 'location':
      latitude = msg.location?.latitude || null;
      longitude = msg.location?.longitude || null;
      content = `[Location: ${latitude}, ${longitude}]`;
      break;
    case 'interactive':
      const interactive = msg.interactive || {};
      if (interactive.type === 'button_reply') {
        content = interactive.button_reply?.title || '[Button Reply]';
      } else if (interactive.type === 'list_reply') {
        content = interactive.list_reply?.title || '[List Reply]';
      } else {
        content = JSON.stringify(interactive);
      }
      break;
    case 'button':
      content = msg.button?.text || '[Button]';
      break;
    case 'order':
      content = JSON.stringify(msg.order || {});
      break;
    case 'system':
      content = msg.system?.body || '[System Message]';
      break;
    default:
      content = `[${msgType} message]`;
  }

  // Context (reply to another message)
  if (msg.context) {
    contextMsgId = msg.context.id || null;
    // Also can check msg.context.from, msg.context.referred_product
  }

  // 1. Ensure phone number is registered
  const phoneId = registerPhone(waId, profileName);
  if (!phoneId) {
    console.log(`[SKIP] Phone ${waId} not registered (limit reached?)`);
    return null;
  }

  // 2. Get or create conversation
  const tx = db.transaction(() => {
    // Close old active conversations (keep only latest)
    let conv = stmts.getActiveConversation.get({ wa_id: waId });

    if (!conv) {
      // Check daily conversation limit
      if (!checkConversationLimit(waId)) {
        return null;
      }
      stmts.createConversation.run({ wa_id: waId, phone_number_id: phoneId });
      conv = stmts.getActiveConversation.get({ wa_id: waId });
      // Increment daily conversation count
      stmts.incrementDailyUsage.run({ wa_id: waId, conv_inc: 1, msg_inc: 0 });
    }

    // 3. Close other active conversations for this number
    stmts.closeOldConversations.run({ wa_id: waId, keep_id: conv.id });

    // 4. Store message
    const result = stmts.insertMessage.run({
      conversation_id: conv.id,
      wa_id: waId,
      message_id: msg.id || null,
      direction: 'incoming',
      message_type: msgType,
      content: content,
      media_id: mediaId,
      mime_type: mimeType,
      file_size: fileSize,
      filename: filename,
      caption: caption,
      latitude: latitude,
      longitude: longitude,
      context_message_id: contextMsgId,
      metadata: JSON.stringify(msg)
    });

    // 5. Update conversation message count
    stmts.incrementMessageCount.run({ id: conv.id });

    // 6. Increment daily message count
    stmts.incrementDailyUsage.run({ wa_id: waId, conv_inc: 0, msg_inc: 1 });

    return { messageId: result.lastInsertRowid, conversationId: conv.id };
  });

  try {
    return tx();
  } catch (err) {
    console.error('[DB ERROR]', err.message);
    return null;
  }
}

function storeOutgoingMessage(waId, messageId, content, msgType = 'text', extra = {}) {
  const tx = db.transaction(() => {
    let conv = stmts.getActiveConversation.get({ wa_id: waId });
    if (!conv) {
      stmts.createConversation.run({ wa_id: waId, phone_number_id: null });
      conv = stmts.getActiveConversation.get({ wa_id: waId });
    }

    const result = stmts.insertMessage.run({
      conversation_id: conv.id,
      wa_id: waId,
      message_id: messageId || null,
      direction: 'outgoing',
      message_type: msgType,
      content: content,
      media_id: extra.mediaId || null,
      mime_type: extra.mimeType || null,
      file_size: extra.fileSize || null,
      filename: extra.filename || null,
      caption: extra.caption || null,
      latitude: extra.latitude || null,
      longitude: extra.longitude || null,
      context_message_id: extra.contextMessageId || null,
      metadata: extra.metadata || null
    });

    stmts.incrementMessageCount.run({ id: conv.id });
    stmts.incrementDailyUsage.run({ wa_id: waId, conv_inc: 0, msg_inc: 1 });

    return result.lastInsertRowid;
  });

  try {
    return tx();
  } catch (err) {
    console.error('[DB ERROR]', err.message);
    return null;
  }
}

// ===== SEND READ RECEIPT (blue double tick) =====
async function sendReadReceipt(messageId) {
  if (!WHATSAPP_TOKEN) return;
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    }, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 5000
    });
  } catch (err) {
    // Read receipt failure is non-critical, just log
    const detail = err.response?.data?.error?.message || err.message;
    console.debug(`[READ] read receipt: ${detail}`);
  }
}

function registerPhone(waId, name) {
  // Check if number already exists
  const existing = db.prepare('SELECT id, active FROM phone_numbers WHERE wa_id = ?').get(waId);
  if (existing) {
    if (!existing.active) {
      db.prepare('UPDATE phone_numbers SET active = 1 WHERE id = ?').run(existing.id);
    }
    return existing.id;
  }

  // Check limit
  const count = stmts.countActivePhones.get().count;
  if (count >= MAX_PHONE_NUMBERS) {
    console.warn(`[LIMIT] Cannot register ${waId}: max ${MAX_PHONE_NUMBERS} phones reached`);
    return null;
  }

  const result = db.prepare('INSERT INTO phone_numbers (wa_id, name) VALUES (?, ?)').run(waId, name);
  return result.lastInsertRowid;
}

function checkConversationLimit(waId) {
  const usage = stmts.getDailyUsage.get({ wa_id: waId });
  const count = usage ? usage.conversation_count : 0;
  if (count >= MAX_CONVERSATIONS_PER_DAY) {
    console.warn(`[LIMIT] ${waId} hit daily conversation limit (${MAX_CONVERSATIONS_PER_DAY})`);
    return false;
  }
  return true;
}

// ===== MEDIA DOWNLOAD =====
async function downloadMedia(mediaId, waId, messageId, mimeType) {
  if (!WHATSAPP_TOKEN) {
    console.warn('[MEDIA] No WhatsApp token — skipping download');
    return;
  }
  try {
    // 1. Get download URL from Meta API
    const resp = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 10000
    });
    const downloadUrl = resp.data.url;
    if (!downloadUrl) {
      console.warn(`[MEDIA] No download URL for ${mediaId}`);
      return;
    }

    // 2. Determine file extension from mime type
    const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
    const localPath = path.join(MEDIA_DIR, `${mediaId}.${ext}`);

    // 3. Download and save to local file
    const imgResp = await axios.get(downloadUrl, {
      responseType: 'stream',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 30000
    });
    const writer = fs.createWriteStream(localPath);
    await pipeline(imgResp.data, writer);

    // 4. Update DB with local path
    stmts.updateMessageMediaUrl.run(localPath, messageId);
    console.log(`[MEDIA] ✅ Downloaded ${mediaId} → ${localPath}`);
  } catch (err) {
    console.error(`[MEDIA] ❌ Download failed for ${mediaId}: ${err.message}`);
  }
}

// ===== MIDDLEWARE =====
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// ===== VERIFICATION (GET) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[VERIFY] mode=${mode}, challenge=${challenge ? 'present' : 'missing'}`);

  const crypto = require('crypto');
  const tokenBuf = Buffer.from(String(token || ''));
  const verifyBuf = Buffer.from(VERIFY_TOKEN);
  const tokenOk = tokenBuf.length === verifyBuf.length &&
    crypto.timingSafeEqual(tokenBuf, verifyBuf);
  if (mode === 'subscribe' && tokenOk) {
    console.log('[VERIFY] ✅ Verification successful');
    res.status(200).send(challenge);
  } else {
    console.warn('[VERIFY] ❌ Verification failed');
    res.status(403).send('Verification failed');
  }
});

// ===== INCOMING EVENTS (POST) =====
app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account' && body.entry) {
    body.entry.forEach(entry => {
      if (entry.changes) {
        entry.changes.forEach(change => {
          if (change.field === 'messages') {
            const value = change.value;
            const metadata = value.metadata || {};
            const businessPhone = metadata.display_phone_number || '';

            // --- Status updates ---
            if (value.statuses) {
              value.statuses.forEach(status => {
                console.log(`[STATUS] ${status.status} | msg:${status.id} | to:${status.recipient_id}`);
                // Store status update in messages table as outgoing with status info
                storeOutgoingMessage(status.recipient_id, status.id, 
                  `[${status.status}]`, 'text',
                  { metadata: JSON.stringify(status) }
                );
              });
            }

            // --- Incoming messages ---
            if (value.messages) {
              value.messages.forEach(msg => {
                const from = msg.from;
                const profileName = value.contacts?.[0]?.profile?.name || null;

                console.log(`[INCOMING] ${msg.type} from ${from}: ${msg.text?.body || msg.type}`);

                const result = storeIncomingMessage(from, profileName, msg);
                if (result) {
                  console.log(`[DB] Stored msg #${result.messageId} in conversation #${result.conversationId}`);
                  // Trigger media download for image/video/document messages
                  if (msg.type === 'image' && msg.image?.id) {
                    downloadMedia(msg.image.id, from, result.messageId, msg.image?.mime_type);
                  } else if (msg.type === 'video' && msg.video?.id) {
                    downloadMedia(msg.video.id, from, result.messageId, msg.video?.mime_type);
                  } else if (msg.type === 'document' && msg.document?.id) {
                    downloadMedia(msg.document.id, from, result.messageId, msg.document?.mime_type);
                  }
                }
                // Send read receipt (blue double tick) for incoming messages
                if (msg.id) {
                  sendReadReceipt(msg.id);
                }
              });
            }

            // --- Errors ---
            if (value.errors) {
              value.errors.forEach(err => {
                console.error(`[ERROR] ${err.code}: ${err.title}`);
              });
            }
          }
        });
      }
    });
  }

  res.status(200).send('EVENT_RECEIVED');
});

// ===== API ENDPOINTS for processor =====

// Get unprocessed incoming messages
app.get('/api/messages/pending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const messages = db.prepare(`
    SELECT m.*, c.started_at as conversation_started
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE m.direction = 'incoming' AND m.processed = 0
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(limit);
  res.json(messages);
});

// Mark message as processed
app.post('/api/messages/:id/processed', (req, res) => {
  db.prepare('UPDATE messages SET processed = 1 WHERE id = ?').run(req.params.id);
  res.json({ status: 'ok' });
});

// Get conversation history for a wa_id
app.get('/api/conversations/:waId/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const messages = db.prepare(`
    SELECT m.id, m.message_id, m.direction, m.message_type, m.content,
           m.media_id, m.mime_type, m.filename, m.caption,
           m.created_at, m.processed
    FROM messages m
    WHERE m.wa_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(req.params.waId, limit);
  res.json(messages.reverse());
});

// Get daily stats
app.get('/api/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM phone_numbers WHERE active = 1) as total_phones,
      (SELECT COUNT(*) FROM conversations WHERE status = 'active') as active_conversations,
      (SELECT COUNT(*) FROM messages WHERE date(created_at) = date('now')) as today_messages,
      (SELECT COUNT(*) FROM messages WHERE direction = 'incoming' AND processed = 0) as pending_messages
  `).get();
  
  const topToday = db.prepare(`
    SELECT wa_id, conversation_count, message_count 
    FROM daily_usage WHERE date = date('now')
    ORDER BY message_count DESC LIMIT 10
  `).all();
  
  stats.daily_usage = topToday;
  res.json(stats);
});

// Check if a number has reached daily limit
app.get('/api/limits/:waId', (req, res) => {
  const usage = db.prepare(`
    SELECT conversation_count, message_count FROM daily_usage 
    WHERE wa_id = ? AND date = date('now')
  `).get(req.params.waId);
  
  res.json({
    wa_id: req.params.waId,
    conversations_today: usage?.conversation_count || 0,
    max_conversations: MAX_CONVERSATIONS_PER_DAY,
    messages_today: usage?.message_count || 0,
    limit_reached: (usage?.conversation_count || 0) >= MAX_CONVERSATIONS_PER_DAY
  });
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    db: path.basename(DB_PATH),
    total_phones: db.prepare('SELECT COUNT(*) as c FROM phone_numbers').get().c,
    active_convos: db.prepare('SELECT COUNT(*) as c FROM conversations WHERE status = ?').get('active').c,
    pending_msgs: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'incoming' AND processed = 0").get().c
  });
});

// ===== START =====
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ WhatsApp Webhook v2 (with DB)`);
  console.log(`   Port: ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Verify token: ${VERIFY_TOKEN}`);
  console.log(`   Max phones: ${MAX_PHONE_NUMBERS}`);
  console.log(`   Max convos/day/phone: ${MAX_CONVERSATIONS_PER_DAY}`);
});
