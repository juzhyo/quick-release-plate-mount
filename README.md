# TORQ — quick-release number plate mount shop

Static Hugo storefront + Cloudflare Pages Functions for Stripe checkout and
live courier rate lookups (DHL, FedEx; SingPost via static rate card, see
`functions/api/shipping-rates.js`).

## Run locally

```bash
# Hugo (site only, no Functions)
hugo server -D

# Full stack incl. /api/* Functions, using Cloudflare's local emulator
npx wrangler pages dev public --kv RATES_KV
```

Build the static site first (`hugo`) before running `wrangler pages dev`,
since it serves the `public/` output directory.

## One-time setup

1. **Stripe**
   - Create a Product + Price in the Stripe Dashboard for the kit — copy the
     Price ID into the `PRODUCT_PRICE_ID` env var.
   - Copy the **publishable** key into `hugo.toml` → `params.stripePublishableKey`
     (this one is safe to commit).
   - Copy the **secret** key into the `STRIPE_SECRET_KEY` env var — never commit this.
   - Add a webhook endpoint pointing at `/api/stripe-webhook`, listening for
     `checkout.session.completed`, and put its signing secret in
     `STRIPE_WEBHOOK_SECRET`.

2. **Courier APIs**
   - DHL: register at developer.dhl.com for MyDHL API sandbox/production
     credentials → `DHL_CLIENT_ID`, `DHL_CLIENT_SECRET`, `DHL_ACCOUNT_NUMBER`.
   - FedEx: register at developer.fedex.com for the Rate API →
     `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER`.
   - SingPost: no open real-time rating API at present. Either keep the
     static rate card in `quoteSingPost()`, request EDI/API access via your
     SingPost account manager, or route all three carriers through an
     aggregator (Shippo / EasyParcel / Easyship) that already resells
     SingPost rates alongside DHL/FedEx behind one API — usually the faster
     path if you don't already have a SingPost business account.
   - Set `SHOP_ORIGIN_COUNTRY`, `SHOP_ORIGIN_POSTAL`, `PARCEL_WEIGHT_KG`,
     `PARCEL_DIMS_CM` to match your actual fulfilment address and packed kit.

3. **Cloudflare Pages**
   - Push this repo to GitHub, connect it in the Cloudflare Pages dashboard.
   - Build command: `hugo`, output directory: `public`.
   - Under **Settings → Functions**, add a KV namespace binding named
     `RATES_KV` (create the namespace under Workers → KV first).
   - Under **Settings → Environment variables**, add every var listed above
     for both Production and Preview (use Stripe **test** keys for Preview).

## How checkout works

1. Customer enters destination + qty → `POST /api/shipping-rates` calls
   DHL/FedEx/SingPost, returns quotes, and caches each one server-side in KV
   under a random `quoteId`.
2. Customer picks a rate → `POST /api/checkout` looks the `quoteId` back up
   in KV (never trusts a price the browser sends) and creates a Stripe
   Checkout Session with the product + that shipping line item.
3. Browser redirects to Stripe's hosted payment page. On success, Stripe
   redirects to `/order-confirmed`.
4. Stripe also calls `/api/stripe-webhook` server-to-server — that's the
   reliable place to mark an order paid and trigger fulfilment, since a
   customer can close the tab before the redirect completes.

## Still to build

- `/order-confirmed` page (create `content/order-confirmed.md` +
  matching layout).
- `/shipping`, `/returns`, `/privacy` pages — linked from the footer but not
  yet created.
- Order storage: the webhook currently only logs to the Functions log.
  Add a Cloudflare D1 database (or an email via Resend/SendGrid) inside
  `functions/api/stripe-webhook.js` where the `TODO` is.
- Real product photography/render to replace the placeholder SVG in the hero
  (`layouts/index.html` → `.hero__render`).
- Sales tax / GST: turn on Stripe Tax in the Dashboard, or add
  `automatic_tax[enabled]=true` to the Checkout Session params in
  `functions/api/checkout.js`.
