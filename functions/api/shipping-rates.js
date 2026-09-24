// POST /api/shipping-rates
// Body: { destinationCountry, destinationPostal, variant }   variant: 'one' | 'two'
// Returns: { quotes: [{ quoteId, carrier, service, amount, currency, etaDays }] }
//
// Requires these Cloudflare Pages bindings (Pages dashboard → Settings → Bindings):
//   env vars:  DHL_CLIENT_ID, DHL_CLIENT_SECRET, FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET,
//              SHOP_ORIGIN_COUNTRY, SHOP_ORIGIN_POSTAL, PARCEL_WEIGHT_KG, PARCEL_DIMS_CM
//   KV binding: RATES_KV  (stores the authoritative quote so /api/checkout can't be
//               tricked by a client-supplied price)

const QUOTE_TTL_SECONDS = 60 * 15; // quotes are valid for 15 minutes

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const { destinationCountry, destinationPostal, variant } = body;
  if (!destinationCountry || !destinationPostal || !variant) {
    return json({ error: 'missing destinationCountry, destinationPostal, or variant' }, 400);
  }
  if (variant !== 'one' && variant !== 'two') {
    return json({ error: 'unknown variant' }, 400);
  }

  // How many kits in the parcel. 'one' = a front+back set (2 plates);
  // 'two' = two such sets. Drives parcel weight, and therefore the rate.
  const sets = variant === 'two' ? 2 : 1;

  const parcel = {
    weightKg: Number(env.PARCEL_WEIGHT_KG || 0.3) * sets,
    dims: (env.PARCEL_DIMS_CM || '20x15x5').split('x').map(Number), // L x W x H cm
  };

  const results = await Promise.allSettled([
    quoteDHL(env, destinationCountry, destinationPostal, parcel),
    quoteFedEx(env, destinationCountry, destinationPostal, parcel),
    quoteSingPost(env, destinationCountry, destinationPostal, parcel),
  ]);

  const quotes = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) quotes.push(...r.value);
  }

  quotes.sort((a, b) => a.amount - b.amount);

  // Cache each quote server-side so checkout can verify the price it's given.
  for (const q of quotes) {
    q.quoteId = crypto.randomUUID();
    await env.RATES_KV.put(
      `quote:${q.quoteId}`,
      JSON.stringify({ ...q, variant, destinationCountry, destinationPostal }),
      { expirationTtl: QUOTE_TTL_SECONDS }
    );
  }

  return json({ quotes });
}

// --- DHL Express (MyDHL API) -------------------------------------------------
// Docs: https://developer.dhl.com/api-reference/dhl-express-mydhl-api
async function quoteDHL(env, country, postal, parcel) {
  if (!env.DHL_CLIENT_ID) return null; // not configured, skip silently
  try {
    const auth = btoa(`${env.DHL_CLIENT_ID}:${env.DHL_CLIENT_SECRET}`);
    const res = await fetch('https://express.api.dhl.com/mydhlapi/rates', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerDetails: {
          shipperDetails: { postalCode: env.SHOP_ORIGIN_POSTAL, countryCode: env.SHOP_ORIGIN_COUNTRY },
          receiverDetails: { postalCode: postal, countryCode: country },
        },
        accounts: [{ typeCode: 'shipper', number: env.DHL_ACCOUNT_NUMBER }],
        plannedShippingDateAndTime: new Date().toISOString(),
        unitOfMeasurement: 'metric',
        packages: [{ weight: parcel.weightKg, dimensions: { length: parcel.dims[0], width: parcel.dims[1], height: parcel.dims[2] } }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.products || []).slice(0, 2).map(p => ({
      carrier: 'DHL',
      service: p.productName,
      amount: p.totalPrice?.[0]?.price ?? 0,
      currency: p.totalPrice?.[0]?.currencyType ?? 'SGD',
      etaDays: p.deliveryCapabilities?.estimatedDeliveryDateAndTime
        ? daysUntil(p.deliveryCapabilities.estimatedDeliveryDateAndTime) : 3,
    }));
  } catch {
    return null;
  }
}

// --- FedEx (Rate API v1) ------------------------------------------------------
// Docs: https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html
async function quoteFedEx(env, country, postal, parcel) {
  if (!env.FEDEX_CLIENT_ID) return null;
  try {
    const tokenRes = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.FEDEX_CLIENT_ID,
        client_secret: env.FEDEX_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) return null;
    const { access_token } = await tokenRes.json();

    const res = await fetch('https://apis.fedex.com/rate/v1/rates/quotes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountNumber: { value: env.FEDEX_ACCOUNT_NUMBER },
        requestedShipment: {
          shipper: { address: { postalCode: env.SHOP_ORIGIN_POSTAL, countryCode: env.SHOP_ORIGIN_COUNTRY } },
          recipient: { address: { postalCode: postal, countryCode: country } },
          pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
          rateRequestType: ['ACCOUNT'],
          requestedPackageLineItems: [{
            weight: { units: 'KG', value: parcel.weightKg },
            dimensions: { length: parcel.dims[0], width: parcel.dims[1], height: parcel.dims[2], units: 'CM' },
          }],
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.output?.rateReplyDetails || []).slice(0, 2).map(r => ({
      carrier: 'FedEx',
      service: r.serviceName,
      amount: r.ratedShipmentDetails?.[0]?.totalNetCharge ?? 0,
      currency: r.ratedShipmentDetails?.[0]?.currency ?? 'SGD',
      etaDays: r.commit?.transitDays ?? 4,
    }));
  } catch {
    return null;
  }
}

// --- SingPost -----------------------------------------------------------------
// SingPost does not currently publish an open real-time rating API — most
// integrations go through EDI onboarding. This is a static rate-card fallback;
// swap for a call to your SingPost account rep's API once onboarded, or route
// this carrier through a multi-carrier aggregator (Shippo / EasyParcel /
// Easyship) that already resells SingPost rates via one API.
async function quoteSingPost(env, country, postal, parcel) {
  // Free delivery on every order within Singapore — matches the storefront's
  // "Free SG delivery" promise and the TikTok Shop listing.
  if (country === 'SG') {
    return [{
      carrier: 'SingPost',
      service: 'Free Delivery (Singapore)',
      amount: 0,
      currency: 'SGD',
      etaDays: 2,
      free: true,
    }];
  }
  const flatRates = { MY: 12, AU: 22, GB: 24, US: 26 };
  const base = flatRates[country];
  if (base === undefined) return null;
  return [{
    carrier: 'SingPost',
    service: 'Air Mail',
    amount: base + Math.max(0, parcel.weightKg - 0.5) * 4,
    currency: 'SGD',
    etaDays: 10,
  }];
}

function daysUntil(isoDate) {
  const diff = new Date(isoDate) - new Date();
  return Math.max(1, Math.round(diff / 86400000));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
