#!/usr/bin/env python3
"""
WhatsApp Webhook Receiver
=========================
Receive WhatsApp messages and forward them to the Task Router.
Zero-LLM - pure routing.
"""

import json
import logging
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests

ROUTER_URL = os.getenv("ROUTER_URL", "http://127.0.0.1:3002")
LOG_FILE = os.getenv("LOG_FILE", "/home/fizi/projects/task-router/whatsapp.log")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        
        # Extract WhatsApp message info
        sender = data.get("sender", data.get("from", ""))
        chat_id = data.get("chat_id", data.get("chat", {}).get("id", ""))
        message = data.get("message", data.get("text", ""))
        
        logger.info(f"WhatsApp: {sender} -> {chat_id}: {message[:50]}...")
        
        # Forward to router
        payload = {
            "platform": "whatsapp",
            "sender": sender,
            "chat_id": chat_id,
            "message": message
        }
        
        try:
            resp = requests.post(f"{ROUTER_URL}", json=payload, timeout=10)
            logger.info(f"Router response: {resp.status_code}")
        except Exception as e:
            logger.error(f"Router failed: {e}")
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode())
    
    def do_GET(self):
        # Health check
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "healthy", "service": "whatsapp-webhook"}).encode())
    
    def log_message(self, format, *args):
        logger.info(f"{self.address_string()} - {format % args}")

def main():
    port = int(os.getenv("WEBHOOK_PORT", "3003"))
    server = HTTPServer(("127.0.0.1", port), WebhookHandler)
    logger.info(f"WhatsApp Webhook started on port {port}")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Webhook shutting down")
        server.shutdown()

if __name__ == "__main__":
    main()
