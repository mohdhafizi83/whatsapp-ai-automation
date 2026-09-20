#!/usr/bin/env python3
"""
myinfo - Personal Data Hub CLI
===============================
Private data store for the personal WhatsApp assistant.
All data stays local on this server — never touches cloud.

Commands:
  myinfo add <text> [--cat CATEGORY]
  myinfo list [--cat CATEGORY] [--id ID]
  myinfo search <query>
  myinfo update <id> <new-text>
  myinfo delete <id>
  myinfo export <file.json>
  myinfo import <file.json>
  myinfo stats
"""

import sqlite3
import json
import os
import sys
import argparse
import urllib.request
import urllib.error
from datetime import datetime

# ── Config ──────────────────────────────────────────────
DB_PATH = os.environ.get('MYINFO_DB',
            os.path.expanduser('~/.myinfo/data.db'))
LOCAL_MODEL_URL = os.environ.get('LOCAL_MODEL_URL',
                     'http://127.0.0.1:8081/v1/chat/completions')
CATEGORIES = [
    'identity', 'contact', 'family', 'work',
    'finance', 'medical', 'event', 'document',
    'sensitive', 'general'
]

# ── Database ────────────────────────────────────────────
def get_db():
    db_dir = os.path.dirname(DB_PATH)
    os.makedirs(db_dir, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute('''
        CREATE TABLE IF NOT EXISTS personal_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT DEFAULT 'general',
            label TEXT,
            summary TEXT NOT NULL,
            details TEXT,
            owner TEXT DEFAULT 'hafizi',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    ''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_category ON personal_data(category)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_label ON personal_data(label)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_owner ON personal_data(owner)')
    db.commit()
    return db

# ── Local LLM Helper ────────────────────────────────────
def classify_with_llm(text):
    """Use Qwen3.5-4B to auto-categorise and extract structured info."""
    if not text.strip():
        return None, text.strip()

    prompt = f"""Extract personal information from the text below.

Rules:
1. Determine the BEST category from: {', '.join(CATEGORIES)}
2. Create a concise label (3-5 words, lowercase, underscores)
3. Extract the KEY information directly — do NOT describe the text, just give the fact
4. Use Malay if the input is Malay, English if the input is English
5. Keep summary under 100 chars

Text: "{text}"

Examples:
Input: "Nama penuh saya Mohd Hafizi bin Abdullah"
Output: {{"category": "identity", "label": "full_name", "summary": "Nama: Mohd Hafizi bin Abdullah", "details": ""}}

Input: "Saya kerja di Maybank dari 2010-2015"
Output: {{"category": "work", "label": "maybank_employment", "summary": "Kerja di Maybank 2010-2015", "details": ""}}

Input: "Isteri saya nama Norazlin"
Output: {{"category": "family", "label": "wife_name", "summary": "Isteri: Norazlin", "details": ""}}

Respond ONLY with valid JSON, no explanation.
"""

    payload = {
        "model": "local",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 256,
        "temperature": 0.2,
        "chat_template_kwargs": {"enable_thinking": False}
    }

    try:
        req = urllib.request.Request(
            LOCAL_MODEL_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            content = result['choices'][0]['message']['content'].strip()

        # Extract JSON from response
        if content.startswith('```'):
            content = content.split('\n', 1)[1]
            content = content.rsplit('\n```', 1)[0]
        parsed = json.loads(content)
        cat = parsed.get('category', 'general')
        if cat not in CATEGORIES:
            cat = 'general'
        return cat, parsed.get('label', ''), parsed.get('summary', text), parsed.get('details', '')
    except Exception as e:
        print(f"[myinfo] LLM classification failed: {e}", file=sys.stderr)
        return None, text

# ── Commands ────────────────────────────────────────────
def cmd_add(args):
    """Add new personal data entry."""
    db = get_db()
    now = datetime.now().isoformat()
    owner = args.owner if args.owner else 'hafizi'

    if args.category:
        cat = args.category
        label = ''
        summary = args.text
        details = ''
    else:
        result = classify_with_llm(args.text)
        if result and result[0]:
            cat, label, summary, details = result
        else:
            cat, label, summary, details = 'general', '', args.text, ''

    db.execute(
        'INSERT INTO personal_data (category, label, summary, details, owner, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        (cat, label, summary, details, owner, now, now)
    )
    db.commit()
    entry_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
    owner_tag = f"@{owner}" if owner != 'hafizi' else ""
    print(f"✅ [{cat.upper()}] #{entry_id} {owner_tag}— {summary}")
    db.close()


def cmd_list(args):
    """List personal data entries."""
    db = get_db()
    if args.entry_id:
        rows = db.execute(
            'SELECT * FROM personal_data WHERE id = ?', (args.entry_id,)
        ).fetchall()
    elif args.category:
        rows = db.execute(
            'SELECT * FROM personal_data WHERE category = ? ORDER BY updated_at DESC',
            (args.category,)
        ).fetchall()
    else:
        rows = db.execute(
            'SELECT * FROM personal_data ORDER BY updated_at DESC'
        ).fetchall()

    if not rows:
        print("📭 Tiada data.")
        db.close()
        return

    for r in rows:
        label_str = f" [{r['label']}]" if r['label'] else ''
        owner_str = f"@{r['owner']}" if r['owner'] and r['owner'] != 'hafizi' else ''
        print(f"#{r['id']:3d} {owner_str:6s}[{r['category']:10s}]{label_str}  {r['summary'][:80]}")
    print(f"\nTotal: {len(rows)} entries")
    db.close()


def cmd_search(args):
    """Search personal data."""
    db = get_db()
    q = f"%{args.query}%"
    rows = db.execute(
        'SELECT * FROM personal_data WHERE summary LIKE ? OR details LIKE ? OR label LIKE ? '
        'ORDER BY updated_at DESC',
        (q, q, q)
    ).fetchall()

    if not rows:
        print(f"🔍 No results for '{args.query}'")
        db.close()
        return

    for r in rows:
        label_str = f" [{r['label']}]" if r['label'] else ''
        print(f"#{r['id']:3d}  [{r['category']:10s}]{label_str}  {r['summary'][:100]}")
    print(f"\nFound: {len(rows)} entries")
    db.close()


def cmd_update(args):
    """Update existing entry."""
    db = get_db()
    existing = db.execute('SELECT * FROM personal_data WHERE id = ?',
                         (args.entry_id,)).fetchone()
    if not existing:
        print(f"❌ Entry #{args.entry_id} not found.")
        db.close()
        return

    now = datetime.now().isoformat()
    result = classify_with_llm(args.text)
    if result and result[0]:
        cat, label, summary, details = result
    else:
        cat, label, summary, details = existing['category'], '', args.text, ''

    db.execute(
        'UPDATE personal_data SET category=?, label=?, summary=?, details=?, updated_at=? WHERE id=?',
        (cat, label, summary, details, now, args.entry_id)
    )
    db.commit()
    print(f"✅ Updated #{args.entry_id}")
    db.close()


def cmd_delete(args):
    """Delete an entry."""
    db = get_db()
    existing = db.execute('SELECT * FROM personal_data WHERE id = ?',
                         (args.entry_id,)).fetchone()
    if not existing:
        print(f"❌ Entry #{args.entry_id} not found.")
        db.close()
        return

    db.execute('DELETE FROM personal_data WHERE id = ?', (args.entry_id,))
    db.commit()
    print(f"🗑️  Deleted #{args.entry_id}: {existing['summary'][:60]}")
    db.close()


def cmd_export(args):
    """Export all data to JSON file."""
    db = get_db()
    rows = db.execute('SELECT * FROM personal_data ORDER BY id').fetchall()
    data = [{
        'id': r['id'],
        'category': r['category'],
        'label': r['label'],
        'summary': r['summary'],
        'details': r['details'],
        'owner': r['owner'],
        'created_at': r['created_at'],
        'updated_at': r['updated_at']
    } for r in rows]

    with open(args.file, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"📤 Exported {len(data)} entries to {args.file}")
    db.close()


def cmd_import(args):
    """Import data from JSON file."""
    if not os.path.exists(args.file):
        print(f"❌ File not found: {args.file}")
        return

    with open(args.file) as f:
        data = json.load(f)

    db = get_db()
    now = datetime.now().isoformat()
    count = 0
    for item in data:
        db.execute(
            'INSERT INTO personal_data (category, label, summary, details, owner, created_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (item.get('category', 'general'),
             item.get('label', ''),
             item.get('summary', ''),
             item.get('details', ''),
             item.get('owner', 'hafizi'),
             item.get('created_at', now),
             item.get('updated_at', now))
        )
        count += 1
    db.commit()
    print(f"📥 Imported {count} entries from {args.file}")
    db.close()


def cmd_stats(args):
    """Show database statistics."""
    db = get_db()
    total = db.execute('SELECT COUNT(*) FROM personal_data').fetchone()[0]
    by_cat = db.execute(
        'SELECT category, COUNT(*) as c FROM personal_data GROUP BY category ORDER BY c DESC'
    ).fetchall()

    print(f"📊 Personal Data Hub Stats")
    print(f"{'='*40}")
    print(f"Total entries: {total}")
    print(f"Database: {DB_PATH}")
    print()
    if by_cat:
        print("By category:")
        for r in by_cat:
            print(f"  [{r['category']:12s}]  {r['c']}")
    db.close()


# ── Main ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description='myinfo — Personal Data Hub (private, local only)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  myinfo add "Nama penuh saya Mohd Hafizi bin Abdullah"
  myinfo add --cat identity "IC: 801231-XX-XXXX"
  myinfo list
  myinfo list --cat family
  myinfo search "maybank"
  myinfo update 5 "Alamat rumah: No 10, Jalan Baru"
  myinfo delete 3
  myinfo export backup.json
  myinfo import backup.json
  myinfo stats
        """
    )
    sub = parser.add_subparsers(dest='command', required=True)

    # add
    p_add = sub.add_parser('add', help='Add new personal data')
    p_add.add_argument('text', help='Information to store')
    p_add.add_argument('--cat', '--category', dest='category',
                       choices=CATEGORIES, help='Manual category (skip LLM)')
    p_add.add_argument('--owner', choices=['hafizi', 'wife'], default='hafizi',
                       help="Data owner: 'hafizi' (default) or 'wife'")

    # list
    p_list = sub.add_parser('list', help='List entries')
    p_list.add_argument('--cat', '--category', dest='category',
                        choices=CATEGORIES, help='Filter by category')
    p_list.add_argument('--id', dest='entry_id', type=int, help='Show specific entry')

    # search
    p_search = sub.add_parser('search', help='Search entries')
    p_search.add_argument('query', help='Search keyword')

    # update
    p_update = sub.add_parser('update', help='Update entry')
    p_update.add_argument('entry_id', type=int, help='Entry ID to update')
    p_update.add_argument('text', help='New information')

    # delete
    p_delete = sub.add_parser('delete', help='Delete entry')
    p_delete.add_argument('entry_id', type=int, help='Entry ID to delete')

    # export
    p_export = sub.add_parser('export', help='Export to JSON')
    p_export.add_argument('file', help='Output file path')

    # import
    p_import = sub.add_parser('import', help='Import from JSON')
    p_import.add_argument('file', help='Input file path')

    # stats
    sub.add_parser('stats', help='Database statistics')

    args = parser.parse_args()

    commands = {
        'add': cmd_add,
        'list': cmd_list,
        'search': cmd_search,
        'update': cmd_update,
        'delete': cmd_delete,
        'export': cmd_export,
        'import': cmd_import,
        'stats': cmd_stats,
    }

    commands[args.command](args)


if __name__ == '__main__':
    main()
