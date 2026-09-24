(() => {
  const buybar     = document.querySelector('.buybar');
  const toggleBtn  = document.getElementById('buybar-toggle');
  const formEl     = document.getElementById('buybar-form');
  const summaryEl  = document.getElementById('buybar-summary');
  const priceEl    = document.getElementById('buybar-price');
  const variantEl  = document.getElementById('variant');
  const countryEl  = document.getElementById('dest-country');
  const postalEl   = document.getElementById('dest-postal');
  const getRatesBtn = document.getElementById('get-rates');
  const ratesBox   = document.getElementById('rate-options');
  const checkoutBtn = document.getElementById('checkout');
  const statusEl   = document.getElementById('buybar-status');

  // Loaded on every page, but the buy bar only exists on pages that sell.
  // Bail out rather than throwing on a null element.
  if (!buybar || !toggleBtn || !formEl || !summaryEl || !priceEl || !variantEl || !countryEl ||
      !postalEl || !getRatesBtn || !ratesBox || !checkoutBtn || !statusEl) {
    return;
  }

  let selectedQuoteId = null;

  function setStatus(msg) { statusEl.textContent = msg || ''; }

  function setExpanded(expanded) {
    buybar.dataset.state = expanded ? 'expanded' : 'collapsed';
    formEl.hidden = !expanded;
    toggleBtn.setAttribute('aria-expanded', String(expanded));
    toggleBtn.textContent = expanded ? 'Hide' : 'Buy';
  }

  function isExpanded() { return buybar.dataset.state === 'expanded'; }

  // Keep the collapsed summary in step with the chosen kit. Both the big price
  // and the label come from the selected option, so the bar can never show a
  // price that disagrees with the kit it names.
  function syncSummary() {
    const opt = variantEl.options[variantEl.selectedIndex];
    if (!opt) return;
    const price = parseFloat(opt.dataset.price);
    if (!Number.isNaN(price)) {
      priceEl.textContent = 'S$' + price.toFixed(2);
    }
    // "Two Bumper — S$52.90" -> "Two Bumper" for the label beside the price.
    summaryEl.textContent = opt.textContent.split('—')[0].trim();
  }

  toggleBtn.addEventListener('click', () => setExpanded(!isExpanded()));

  // Any in-page "buy" link expands the bar instead of relying on scroll
  // position — reaching the buy moment is intent, not proximity.
  document.querySelectorAll('a[href="#buy"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      setExpanded(true);
      const focusTarget = countryEl;
      // Wait for the form to become visible before moving focus.
      requestAnimationFrame(() => {
        buybar.scrollIntoView({ behavior: 'smooth', block: 'end' });
        focusTarget.focus({ preventScroll: true });
      });
    });
  });

  // Escape collapses it again, matching the usual disclosure pattern.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isExpanded()) {
      setExpanded(false);
      toggleBtn.focus();
    }
  });

  // A quote is cached server-side against the variant it was priced for, so
  // switching kits invalidates it — make the buyer re-fetch rather than let
  // them check out and hit a server-side rejection.
  function invalidateQuote(msg) {
    selectedQuoteId = null;
    checkoutBtn.disabled = true;
    ratesBox.innerHTML = '';
    if (msg) setStatus(msg);
  }

  variantEl.addEventListener('change', () => {
    syncSummary();
    invalidateQuote('Kit changed — get shipping again for this kit.');
  });

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
          variant: variantEl.value
        })
      });

      if (!res.ok) throw new Error('rate lookup failed');
      const data = await res.json();

      if (!data.quotes || data.quotes.length === 0) {
        setStatus("No couriers currently serve that address — email us and we'll sort it manually.");
        return;
      }

      data.quotes.forEach((q, i) => {
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
          variant: variantEl.value,
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

  syncSummary();
})();
