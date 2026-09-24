// POST /api/checkout
// Body: { quantity, quoteId }
// Returns: { url }  — redirect the browser here (Stripe-hosted Checkout page)
//
// Requires env vars: STRIPE_SECRET_KEY, PRODUCT_PRICE_ID (a Price created in the
// Stripe Dashboard for the plate-mount kit), SITE_URL
// Requires KV binding: RATES_KV (shared with shipping-rates.js)

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const { quantity, quoteId } = body;
  if (!quantity || !quoteId) {
    return json({ error: 'missing quantity or quoteId' }, 400);
  }

  // Re-read the quote WE cached server-side — never trust a price from the client.
  const raw = await env.RATES_KV.get(`quote:${quoteId}`);
  if (!raw) {
    return json({ error: 'quote expired, please re-fetch shipping rates' }, 400);
  }
  const quote = JSON.parse(raw);
  if (quote.quantity !== quantity) {
    return json({ error: 'quantity no longer matches the quoted shipping rate' }, 400);
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${env.SITE_URL}/order-confirmed?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${env.SITE_URL}/#buy`);
  params.append('line_items[0][price]', env.PRODUCT_PRICE_ID);
  params.append('line_items[0][quantity]', String(quantity));

  // Shipping as its own line item priced from the live courier quote.
  params.append('line_items[1][price_data][currency]', quote.currency.toLowerCase());
  params.append('line_items[1][price_data][product_data][name]', `Shipping — ${quote.carrier} ${quote.service}`);
  params.append('line_items[1][price_data][unit_amount]', String(Math.round(quote.amount * 100)));
  params.append('line_items[1][quantity]', '1');

  params.append('shipping_address_collection[allowed_countries][0]', quote.destinationCountry);
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
