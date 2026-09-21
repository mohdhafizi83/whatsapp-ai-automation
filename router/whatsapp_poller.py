#!/usr/bin/env python3
"""
WhatsApp Poller - Zero-LLM
============================
Poll the WhatsApp bridge for new messages and dispatch them to the Power Tool API.
Replaces a gateway layer for task receiving.
"""

import json
import logging
import os
import sys
import time
import requests
from datetime import datetime

# Configuration
WHATSAPP_BRIDGE = os.getenv("WHATSAPP_BRIDGE", "http://127.0.0.1:3000")
POWER_TOOL_API = os.getenv("POWER_TOOL_API", "http://localhost:5557/api/dispatch")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "5"))  # seconds
LOG_FILE = os.getenv("LOG_FILE", "/home/fizi/projects/task-router/poller.log")

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# WhatsApp group routing rules
# Routing maps: configure via env (JSON) or routing.json next to this file.
# Example: {"<group-id>@g.us": {"client": "acme", "profile": "acme"}}
def _load_routing(env_var, default="{}"):
    raw = os.getenv(env_var)
    if not raw:
        cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "routing.json")
        if os.path.exists(cfg):
            raw = open(cfg, encoding="utf-8").read()
    try:
        return json.loads(raw or default)
    except json.JSONDecodeError:
        return {}

WHATSAPP_GROUPS = _load_routing("WHATSAPP_GROUPS_JSON")

def poll_messages():
    """Poll the WhatsApp bridge for new messages"""
    try:
        resp = requests.get(f"{WHATSAPP_BRIDGE}/messages", timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.error(f"Poll failed: {e}")
    return []

def dispatch_to_api(platform, sender, chat_id, message):
    """Dispatch message to the Power Tool API"""
    payload = {
        "platform": platform,
        "sender": sender,
        "chat_id": chat_id,
        "message": message,
        "timestamp": datetime.now().isoformat(),
        "route_info": WHATSAPP_GROUPS.get(chat_id, {})
    }
    
    try:
        resp = requests.post(POWER_TOOL_API, json=payload, timeout=10)
        logger.info(f"Dispatched: {platform} {chat_id} -> {resp.status_code}")
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"Dispatch failed: {e}")
        return False

def process_message(msg):
    """Process single message"""
    chat_id = msg.get("chatId", "")
    message = msg.get("message", "")
    sender = msg.get("sender", "")
    
    # Skip empty messages or status updates
    if not message or message == "":
        return
    
    # Skip if message is just a reaction or protocol message
    if message.startswith("<") or len(message) < 2:
        return
    
    logger.info(f"Processing: {sender} -> {chat_id}: {message[:50]}...")
    dispatch_to_api("whatsapp", sender, chat_id, message)

def main():
    logger.info("WhatsApp Poller started (NO LLM)")
    logger.info(f"Bridge: {WHATSAPP_BRIDGE}")
    logger.info(f"Power Tool API: {POWER_TOOL_API}")
    logger.info(f"Poll interval: {POLL_INTERVAL}s")
    
    seen_messages = set()
    
    while True:
        try:
            messages = poll_messages()
            for msg in messages:
                msg_id = msg.get("id", msg.get("key", {}).get("id", ""))
                if msg_id and msg_id not in seen_messages:
                    seen_messages.add(msg_id)
                    process_message(msg)
            
            # Keep seen_messages from growing too large
            if len(seen_messages) > 1000:
                seen_messages = set(list(seen_messages)[-500:])
                
        except Exception as e:
            logger.error(f"Error in main loop: {e}")
        
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
