// POST /api/stripe-webhook
// Configure this URL in the Stripe Dashboard → Developers → Webhooks:
//   https://your-domain.example/api/stripe-webhook
// Listen for: checkout.session.completed
//
// Requires env var: STRIPE_WEBHOOK_SECRET (the "signing secret" from the
// webhook's settings page in the Stripe Dashboard)

export async function onRequestPost({ request, env }) {
  const signature = request.headers.get('stripe-signature');
  const payload = await request.text();

  const valid = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('invalid signature', { status: 400 });
  }

  const event = JSON.parse(payload);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // TODO: this is where an order becomes real. Typical next steps:
      //  - write the order to Cloudflare D1 / your order database
      //  - email the customer + your fulfilment inbox (Resend, SendGrid, Postmark…)
      //  - if you print on demand, push a job to your print queue
      console.log('Order paid:', session.id, session.customer_details?.email, session.metadata);
      break;
    }
    default:
      break; // ignore other event types
  }

  return new Response('ok', { status: 200 });
}

// Stripe signs webhooks as: t=<timestamp>,v1=<hmac-sha256 of "timestamp.payload">
async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const signedPayload = `${parts.t}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

  return expected === parts.v1;
}
