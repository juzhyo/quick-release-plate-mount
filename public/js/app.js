(() => {
  const qtyEl = document.getElementById('qty');
  const countryEl = document.getElementById('dest-country');
  const postalEl = document.getElementById('dest-postal');
  const getRatesBtn = document.getElementById('get-rates');
  const ratesBox = document.getElementById('rate-options');
  const checkoutBtn = document.getElementById('checkout');
  const statusEl = document.getElementById('buybar-status');

  let selectedQuoteId = null;

  function setStatus(msg) { statusEl.textContent = msg || ''; }

  getRatesBtn.addEventListener('click', async () => {
    if (!postalEl.value.trim()) {
      setStatus('Enter a postal code to get shipping quotes.');
      return;
    }
    setStatus('Fetching live courier rates…');
    ratesBox.innerHTML = '';
    checkoutBtn.disabled = true;
    selectedQuoteId = null;

    try {
      const res = await fetch('/api/shipping-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationCountry: countryEl.value,
          destinationPostal: postalEl.value.trim(),
          quantity: Number(qtyEl.value)
        })
      });

      if (!res.ok) throw new Error('rate lookup failed');
      const data = await res.json();

      if (!data.quotes || data.quotes.length === 0) {
        setStatus("No couriers currently serve that address — email us and we'll sort it manually.");
        return;
      }

      data.quotes.forEach((q, i) => {
        const id = `rate-${i}`;
        const label = document.createElement('label');
        label.innerHTML = `
          <input type="radio" name="rate" value="${q.quoteId}" ${i === 0 ? 'checked' : ''}>
          ${q.carrier} ${q.service} — ${q.currency} ${q.amount.toFixed(2)} (${q.etaDays}d)
        `;
        ratesBox.appendChild(label);
      });

      selectedQuoteId = data.quotes[0].quoteId;
      ratesBox.querySelectorAll('input[name="rate"]').forEach(input => {
        input.addEventListener('change', (e) => { selectedQuoteId = e.target.value; });
      });

      checkoutBtn.disabled = false;
      setStatus('Rates from courier partners — prices confirmed at checkout.');
    } catch (err) {
      console.error(err);
      setStatus("Couldn't reach the shipping service. Please try again.");
    }
  });

  checkoutBtn.addEventListener('click', async () => {
    if (!selectedQuoteId) return;
    checkoutBtn.disabled = true;
    setStatus('Redirecting to secure checkout…');

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: Number(qtyEl.value),
          quoteId: selectedQuoteId
        })
      });

      if (!res.ok) throw new Error('checkout session creation failed');
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      console.error(err);
      setStatus("Checkout couldn't start. Please try again or email support.");
      checkoutBtn.disabled = false;
    }
  });
})();
