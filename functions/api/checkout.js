// POST /api/checkout
// Body: { variant, quoteId }   variant: 'one' | 'two'
// Returns: { url }  — redirect the browser here (Stripe-hosted Checkout page)
//
// Requires env vars: STRIPE_SECRET_KEY, SITE_URL, and one Stripe Price per kit:
//   PRODUCT_PRICE_ID_ONE  (One Bumper, S$34.90 -> unit_amount 3490)
//   PRODUCT_PRICE_ID_TWO  (Two Bumper, S$52.90 -> unit_amount 5290)
// Requires KV binding: RATES_KV (shared with shipping-rates.js)
//
// The kit price is resolved from the VARIANT NAME server-side via a fixed map,
// never from a number supplied by the browser — same trust model as the
// shipping quote, which is re-read from KV rather than accepted from the client.

// variant -> env var holding the Stripe Price ID
const VARIANT_PRICE_ENV = {
  one: 'PRODUCT_PRICE_ID_ONE',
  two: 'PRODUCT_PRICE_ID_TWO',
};

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const { variant, quoteId } = body;
  if (!variant || !quoteId) {
    return json({ error: 'missing variant or quoteId' }, 400);
  }

  // Reject anything that isn't a known variant. Do NOT fall through to a
  // default — an unrecognised value must fail loudly, not silently charge
  // whichever price happened to be first.
  const priceEnvKey = VARIANT_PRICE_ENV[variant];
  if (!priceEnvKey) {
    return json({ error: 'unknown variant' }, 400);
  }
  const priceId = env[priceEnvKey];
  if (!priceId) {
    return json({ error: `shipping configuration error: ${priceEnvKey} is not set` }, 500);
  }

  // Re-read the quote WE cached server-side — never trust a price from the client.
  const raw = await env.RATES_KV.get(`quote:${quoteId}`);
  if (!raw) {
    return json({ error: 'quote expired, please re-fetch shipping rates' }, 400);
  }
  const quote = JSON.parse(raw);
  if (quote.variant !== variant) {
    return json({ error: 'variant no longer matches the quoted shipping rate' }, 400);
  }

  // Strip any trailing slash so we never emit a double slash in the redirect
  // URLs (SITE_URL is often pasted straight from the dashboard with one).
  const siteUrl = (env.SITE_URL || '').replace(/\/+$/, '');
  if (!siteUrl) {
    return json({ error: 'shipping configuration error: SITE_URL is not set' }, 500);
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  // Trailing slash matches the URL Hugo actually serves, so Stripe's redirect
  // lands directly instead of bouncing through a 308.
  params.append('success_url', `${siteUrl}/order-confirmed/?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${siteUrl}/#buy`);
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');

  // Shipping as its own line item priced from the live courier quote.
  // Skip the line entirely when the quote is free (SG delivery) — Stripe would
  // accept unit_amount=0, but a "S$0.00 shipping" row only confuses buyers.
  if (!quote.free && quote.amount > 0) {
    params.append('line_items[1][price_data][currency]', quote.currency.toLowerCase());
    params.append('line_items[1][price_data][product_data][name]', `Shipping — ${quote.carrier} ${quote.service}`);
    params.append('line_items[1][price_data][unit_amount]', String(Math.round(quote.amount * 100)));
    params.append('line_items[1][quantity]', '1');
  }

  // Managed Payments (Stripe as merchant of record, for digital goods) is on by
  // default for some accounts and rejects manual shipping parameters. We ship a
  // physical kit with our own courier rates, so disable it for this request.
  // If the account has it switched off, this param is simply ignored.
  params.append('managed_payments[enabled]', 'false');

  params.append('shipping_address_collection[allowed_countries][0]', quote.destinationCountry);
  params.append('metadata[variant]', variant);
  params.append('metadata[carrier]', quote.carrier);
  params.append('metadata[service]', quote.service);
  params.append('metadata[quoteId]', quoteId);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Stripe error', err);
    return json({ error: 'could not create checkout session' }, 502);
  }

  const session = await res.json();

  // Quote is single-use — remove it once spent.
  await env.RATES_KV.delete(`quote:${quoteId}`);

  return json({ url: session.url });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
