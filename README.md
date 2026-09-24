# AlisonT Design — quick-release number plate mount shop

Static Hugo storefront + Cloudflare Pages Functions for Stripe checkout and
live courier rate lookups (DHL, FedEx; SingPost via static rate card, see
`functions/api/shipping-rates.js`).

## Run locally

```bash
# Hugo (site only, no Functions). Hugo is vendored via npm — use the local one.
./node_modules/.bin/hugo server -D

# Full stack incl. /api/* Functions, using Cloudflare's local emulator
./node_modules/.bin/hugo --destination public
npx wrangler pages dev public --kv RATES_KV
```

Build the static site first before running `wrangler pages dev`, since it
serves the `public/` output directory. **Do not commit `public/`** — it is
build output.

## One-time setup

### 1. Stripe

- Create a Product + Price in the Stripe Dashboard for the kit — copy the
  Price ID into the `PRODUCT_PRICE_ID` env var.
- **The Price must be SGD 32.90.** This is the amount actually charged. The
  displayed price on the site comes from `params.priceSGD` in `hugo.toml`,
  which must match it. Stripe is authoritative for what is *charged*; Hugo is
  authoritative for what is *shown*. Nothing in the code enforces that they
  agree — if you change one, change the other.
- Copy the **secret** key into the `STRIPE_SECRET_KEY` env var — never commit this.
- Add a webhook endpoint pointing at `/api/stripe-webhook`, listening for
  `checkout.session.completed`, and put its signing secret in
  `STRIPE_WEBHOOK_SECRET`.

> The publishable key in `hugo.toml` → `params.stripePublishableKey` is
> **currently unused**. Checkout redirects to Stripe's hosted page, so no
> client-side Stripe.js is loaded. Left in place for future use; remove it if
> you don't add Stripe.js.

### 2. Courier APIs

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

### 3. Cloudflare Pages

- Push this repo to GitHub, then connect it in the Cloudflare Pages dashboard.
- **Build command:** `hugo -b $CF_PAGES_URL`
- **Output directory:** `public`
- Set `HUGO_VERSION` to pin the build (Cloudflare's default is whatever
  their build image currently ships — it was 0.147.7 at time of writing).
  This repo vendors Hugo locally via npm, so match that version here.

**Why `-b $CF_PAGES_URL` matters:** every deploy — production *and* every
preview branch — is served from a different `*.pages.dev` subdomain. Without
this flag, `baseURL` in `hugo.toml` is used verbatim, so canonical tags,
`sitemap.xml`, and the `og:image` meta tag all point at the wrong host on
preview deploys.

**KV binding — the dashboard path is now Settings → Bindings:**

1. Workers & Pages → select this Pages project.
2. **Settings → Bindings → Add → KV namespace**
3. Name it `RATES_KV` (under *Variable name*), and select your namespace.
   Create the namespace first under Workers → KV.
4. **Redeploy** for the binding to take effect — it does not apply retroactively.

**Bindings and env vars are per-environment.** Add every one of them to
**both Production and Preview**, or preview deploys will throw on
`env.RATES_KV.get`. Use Stripe **test** keys for Preview.

Pages Functions count against the **Workers Free plan** quota
(100,000 requests/day shared with Workers). Static asset requests are free
and unlimited. No paid plan required.

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

## Known gaps

Ordered by what actually blocks a working shop.

**Blocking**

- `/order-confirmed` page does not exist. Stripe redirects paying customers
  there, so they land on a 404 *after* being charged. Create
  `content/order-confirmed.md` + a matching layout.
- `baseURL` in `hugo.toml` is a placeholder and must be set to the real
  domain (the `-b $CF_PAGES_URL` build flag overrides it at build time).
- Order storage: the webhook only logs to the Functions log. Add a Cloudflare
  D1 database (or an email via Resend/SendGrid) inside
  `functions/api/stripe-webhook.js` where the `TODO` is. **Until this is
  done, a paid order leaves no record anywhere except the log.**

**Correctness**

- `shipping-rates.js` defaults an unparseable carrier price to `0`
  (`?? 0` in `quoteDHL` / `quoteFedEx`). A malformed API response silently
  becomes a S$0.00 shipping quote instead of being dropped. Also, because
  quotes are gathered with `Promise.allSettled`, a total failure of both DHL
  and FedEx produces no error — just a short quote list.
- Sales tax / GST: verify whether S$32.90 is GST-inclusive. If it is not,
  turn on Stripe Tax in the Dashboard, or add `automatic_tax[enabled]=true`
  to the Checkout Session params in `functions/api/checkout.js`.

**Content / assets**

- `/shipping`, `/returns`, `/privacy` pages — linked from the footer but not
  yet created.
- `static/img/` is missing entirely. `favicon.svg` and `og-image.jpg` are
  both referenced from `head.html` and will 404.
- Real product photography/render to replace the placeholder SVG in the hero
  (`layouts/index.html` → `.hero__render`).

**Housekeeping**

- `baseof.html` uses `.Site.LanguageCode`, deprecated in Hugo v0.158.0 (use
  `.Site.Language.Locale`) and slated for removal.
- The build warns `found no layout file for "html" for kind "taxonomy"`,
  emitting stray `/tags/` and `/categories/` index files. Silence with
  `disableKinds = ["taxonomy", "term"]` in `hugo.toml`.
