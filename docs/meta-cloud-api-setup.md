# Meta WhatsApp Cloud API — Step-by-Step Setup

This is the step most people get stuck on. Follow it top to bottom; every step says what to click and where the value goes in `.env`.

**What you need before starting:** a Facebook account, a phone number that can receive SMS/calls (for WhatsApp verification), and ~30 minutes.

---

## Part 1 — Create the Meta app

1. Go to **https://developers.facebook.com** and log in with your Facebook account.
2. If prompted, complete the developer registration (name, country, purpose — "Business" is fine).
3. Click **My Apps** (top right) → **Create App**.
4. Use case: pick **Other** → **Next** → select **Business** as the app type → **Next**.
   - If you see a simpler flow, choose the **Business** option wherever it appears.
5. Fill in:
   - **App name**: anything, e.g. `wa-automation`
   - **Contact email**: your email
   - **Business portfolio** (if shown): create one, e.g. `My Automation` → **Create App**.

## Part 2 — Add the WhatsApp product

6. On your app's dashboard, find the **WhatsApp** card and click **Set up** next to it.
   - If you don't see it: **Add Product** (left sidebar or dashboard) → search **WhatsApp** → **Set up**.
7. Meta shows a "Quickstart" page. It auto-creates a **test WhatsApp number** for you. Keep this page — you'll need the values below.

## Part 3 — Collect the values for `.env`

On the WhatsApp **API Setup** page (left sidebar → **WhatsApp → API Setup**):

8. **Temporary access token** — shown on the page ("Temporary access token", expires after ~24h). For production, create a permanent one:
   - Open **https://business.facebook.com/settings** → your **Business Portfolio** → **Users → System Users**.
   - Click **Add** → name it `wa-webhook`, role **Employee** → **Create**.
   - Select the system user → **Add Assets** → **Apps** → choose your app → **Full control** → **Save**.
   - Click **Generate New Token** → select your app → set expiry **Never** → under *WhatsApp* permissions tick `whatsapp_business_messaging` and `whatsapp_business_management` → **Generate Token**.
   - Copy it into `.env` as `WHATSAPP_TOKEN=***
9. **Phone number ID** — on the API Setup page, copy the numeric **Phone number ID** → `.env`: `WHATSAPP_PHONE_ID=...`
   - (The displayed phone number `+1 555 …` is the test number itself — you don't need it in `.env`.)
10. **App Secret** — go to your **App Dashboard → Settings → Basic**. Copy **App Secret** → `.env`: `APP_SECRET=***
    - This is what the webhook uses to verify `X-Hub-Signature-256` on every POST. Without it, this project rejects all payloads (fail-closed).
11. **Verify token** — you invent this one; Meta will echo it back. Generate:
    ```bash
    openssl rand -hex 32
    ```
    Put it in `.env` as `VERIFY_TOKEN=*** (you'll paste the same value into Meta's webhook form in Part 5).
12. Also set `API_KEY=*** rand -hex 32)` in `.env` (internal API auth between services), then restart your stack: `docker compose up -d --build`.

## Part 4 — Make the webhook reachable (HTTPS required)

Meta can only call your webhook over **public HTTPS** on port 443. `localhost` will not work. Pick one:

- **VPS + reverse proxy (production):** put nginx/Caddy in front of port 3001 with a TLS cert, e.g. `https://wa.yourdomain.com/webhook` → `http://127.0.0.1:3001/webhook`.
- **Quick tunnel for testing (dev only):** run a tunnel and use its URL:
  ```bash
  cloudflared tunnel --url http://localhost:3001
  # or: ngrok http 3001
  ```
  Copy the generated `https://…` URL — your callback URL is `https://…/webhook`.

## Part 5 — Register the webhook with Meta

13. In the WhatsApp dashboard: left sidebar → **Configuration** (under WhatsApp).
14. Under **Webhook**:
    - **Callback URL**: `https://<your-domain-or-tunnel>/webhook`
    - **Verify token**: paste the exact `VERIFY_TOKEN` value from your `.env`
    - Click **Verify and save**.
    - ✅ Success = green check. If it fails: the server logs `[VERIFY] ❌ Verification failed` — usually a token typo, or Meta can't reach your HTTPS URL (test it: `curl https://<your-url>/health` from outside must respond).
15. Under **Webhook fields**, click **Edit** → tick **messages** → **Verify and save** → toggle it to **Subscribed**.
    - Subscribe to `messages` only; this stack doesn't need the other fields.

## Part 6 — Send a test message

16. Back to **API Setup**: click **Send Message** (the "Send WhatsApp message" box).
    - **To**: a real WhatsApp number you can read (test numbers can only message up to 5 verified recipients).
    - Choose any template, send.
17. Watch your server: `docker compose logs -f webhook`. You should see the inbound event logged. Check the DB state:
    ```bash
    curl http://localhost:3001/health   # pending_msgs / total_phones should move
    ```

## Part 7 — Go live with your own number (optional)

The test number expires and is rate-limited. For production:

18. WhatsApp → **API Setup** → **WhatsApp Accounts** section → **Add** → follow the wizard: pick/create a **WhatsApp Business Account**, enter **your real phone number**, verify it by **SMS or voice call** (enter the 6-digit code).
19. **Business Verification** is required to message arbitrary users: Business Settings → **Overview → Verify** → upload business documents (registration, utility bill matching the business name/address). Review takes minutes to days.
20. After verification: update message templates (Meta requires pre-approved **template messages** to *initiate* conversations; replies within a 24-hour customer-service window are free-form), then point `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID` at the production number and re-run Part 5 for its webhook config (same app, same webhook).

## Troubleshooting this flow

| Symptom | Cause / fix |
|---|---|
| Verify button fails | `VERIFY_TOKEN` mismatch (exact string, no quotes/spaces), or your URL isn't public HTTPS. `curl <callback-url>` must reach the server. |
| POST /webhook → 401 in logs | Wrong `APP_SECRET` (must be the App Dashboard → Settings → Basic secret, not the access token). |
| 200 but nothing in DB | You subscribed to the wrong field, or messages field isn't toggled **Subscribed** (Part 5 step 15). |
| Temporary token stopped working | They expire in ~24h — create the permanent system-user token (Part 3 step 8). |
| "Recipient not in sandbox" | Test numbers can only message 5 pre-verified numbers — add the number in API Setup. |
