#!/usr/bin/env python3
"""
Task Router - Zero-LLM
=======================
Routes WhatsApp/Telegram messages to the Power Tool API without any LLM.
Kos: RM 0, Latency: < 100ms
"""

import json
import logging
import os
import sys
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests

# Configuration
POWER_TOOL_API = os.getenv("POWER_TOOL_API", "http://localhost:5557/api/dispatch")
TELEGRAM_NOTIFY = os.getenv("TELEGRAM_NOTIFY", "http://localhost:3001/api/telegram/notify")
LOG_FILE = os.getenv("LOG_FILE", "/home/fizi/projects/task-router/router.log")

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

# Telegram channel routing rules
TELEGRAM_CHANNELS = _load_routing("TELEGRAM_CHANNELS_JSON")

def route_whatsapp(sender, chat_id, message):
    """Route WhatsApp message to the Power Tool API"""
    payload = {
        "platform": "whatsapp",
        "sender": sender,
        "chat_id": chat_id,
        "message": message,
        "timestamp": datetime.now().isoformat(),
        "route_info": WHATSAPP_GROUPS.get(chat_id, {})
    }
    
    try:
        resp = requests.post(POWER_TOOL_API, json=payload, timeout=10)
        logger.info(f"WhatsApp dispatched: {chat_id} -> {resp.status_code}")
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"WhatsApp dispatch failed: {e}")
        return False

def route_telegram(chat_id, message):
    """Route Telegram message to the Power Tool API"""
    payload = {
        "platform": "telegram",
        "chat_id": chat_id,
        "message": message,
        "timestamp": datetime.now().isoformat(),
        "route_info": TELEGRAM_CHANNELS.get(chat_id, {})
    }
    
    try:
        resp = requests.post(POWER_TOOL_API, json=payload, timeout=10)
        logger.info(f"Telegram dispatched: {chat_id} -> {resp.status_code}")
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"Telegram dispatch failed: {e}")
        return False

def send_notification(platform, chat_id, status):
    """Send notification to Telegram"""
    msg = f"✅ [{platform}] Message dispatched to queue\nChat: {chat_id}\nStatus: {status}"
    try:
        requests.post(TELEGRAM_NOTIFY, json={"message": msg}, timeout=5)
    except:
        pass

class RouterHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Health check
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy", "service": "task-router"}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        
        platform = data.get("platform", "").lower()
        
        if platform == "whatsapp":
            success = route_whatsapp(
                data.get("sender", ""),
                data.get("chat_id", ""),
                data.get("message", "")
            )
            if success:
                send_notification("WhatsApp", data.get("chat_id", ""), "queued")
                
        elif platform == "telegram":
            success = route_telegram(
                data.get("chat_id", ""),
                data.get("message", "")
            )
            if success:
                send_notification("Telegram", data.get("chat_id", ""), "queued")
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode())
    
    def log_message(self, format, *args):
        logger.info(f"{self.address_string()} - {format % args}")

def main():
    port = int(os.getenv("ROUTER_PORT", "3002"))
    server = HTTPServer(("127.0.0.1", port), RouterHandler)
    logger.info(f"Task Router started on port {port} (NO LLM)")
    logger.info(f"Power Tool API: {POWER_TOOL_API}")
    logger.info(f"Telegram Notify: {TELEGRAM_NOTIFY}")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Router shutting down")
        server.shutdown()

if __name__ == "__main__":
    main()
