/**
 * Rich Dummy Data Generator for Aruna Paint POS
 */
const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('Logging in as owner...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'password123' })
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${await loginRes.text()}`);
  }
  const sc = loginRes.headers.getSetCookie?.() || [];
  const cookie = (sc.length > 0 ? sc[0] : (loginRes.headers.get('set-cookie') || '')).split(';')[0];
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookie
  };

  async function api(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      console.error(`API Error ${options.method || 'GET'} ${path}:`, json);
      throw new Error(`API failed: ${res.status} - ${typeof json === 'object' ? JSON.stringify(json) : json}`);
    }
    return json;
  }

  // Ensure current shift is initialized
  console.log('Checking shift status...');
  await api('/api/billing/status');

  // Load all products with their subproducts
  console.log('Loading product catalog...');
  const prodList = await api('/api/products?pageSize=100');
  const subMap = new Map();
  for (const p of prodList.items) {
    const detail = await api(`/api/products/${p.id}`);
    if (detail.subProducts?.length > 0) {
      subMap.set(p.name, detail.subProducts[0]);
    }
  }

  console.log(`Found ${subMap.size} products with active stock batches.`);

  // 1. Create Sample Completed Retail Invoices
  console.log('\n--- Creating Sample Invoices ---');

  // Invoice 1: Regular Walk-in Cash Sale
  const pApex4 = subMap.get('Asian Paints Apex Exterior 4L');
  const pBrush3 = subMap.get('Harris Classic Paint Brush 3-inch');
  const pTape1 = subMap.get('3M Scotch Painter Masking Tape 1-inch');

  if (pApex4 && pBrush3) {
    const inv1 = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'INVOICE',
        wholesale: false,
        customerName: 'Kamal Perera',
        customerPhone: '0771234567',
        lines: [
          { kind: 'BATCH', subProductId: pApex4.id, qty: '1' },
          { kind: 'BATCH', subProductId: pBrush3.id, qty: '2' },
          ...(pTape1 ? [{ kind: 'BATCH', subProductId: pTape1.id, qty: '2' }] : [])
        ],
        cashGiven: '12000',
        print: false
      })
    });
    console.log(`✓ Invoice 1 created: ${inv1.no} · Kamal Perera · Rs. ${inv1.netTotal}`);
  }

  // Invoice 2: Wholesale Sale to Building Contractor
  const pApex10 = subMap.get('Asian Paints Apex Exterior 10L');
  const pSealer = subMap.get('Nippon Wall Sealer Primer 4L');
  const pRoller = subMap.get('Harris Paint Roller 9-inch with Tray');

  if (pApex10 && pSealer) {
    const inv2 = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'INVOICE',
        wholesale: true,
        customerName: 'Nimal Silva (Contractor)',
        customerPhone: '0719876543',
        lines: [
          { kind: 'BATCH', subProductId: pApex10.id, qty: '2' },
          { kind: 'BATCH', subProductId: pSealer.id, qty: '3' },
          ...(pRoller ? [{ kind: 'BATCH', subProductId: pRoller.id, qty: '2' }] : [])
        ],
        cashGiven: '55000',
        print: false
      })
    });
    console.log(`✓ Invoice 2 created: ${inv2.no} · Nimal Silva (Wholesale) · Rs. ${inv2.netTotal}`);
  }

  // Invoice 3: Interior Repainting Sale
  const pRoyale4 = subMap.get('Royale Luxury Emulsion White 4L');
  const pDuluxVT = subMap.get('Dulux Velvet Touch Pearl Glo 4L');
  const pSandpaper = subMap.get('Waterproof Sandpaper Sheet Grit 120');

  if (pRoyale4) {
    const inv3 = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'INVOICE',
        wholesale: false,
        customerName: 'Suneth Enterprises',
        customerPhone: '0761122334',
        lines: [
          { kind: 'BATCH', subProductId: pRoyale4.id, qty: '2' },
          ...(pDuluxVT ? [{ kind: 'BATCH', subProductId: pDuluxVT.id, qty: '1' }] : []),
          ...(pSandpaper ? [{ kind: 'BATCH', subProductId: pSandpaper.id, qty: '5' }] : [])
        ],
        cashGiven: '25000',
        print: false
      })
    });
    console.log(`✓ Invoice 3 created: ${inv3.no} · Suneth Enterprises · Rs. ${inv3.netTotal}`);
  }

  // 2. Create Active Quotations (Estimate)
  console.log('\n--- Creating Quotations ---');
  const pDuluxWS = subMap.get('Dulux Weathershield Brilliant White 4L');
  const pVarnish = subMap.get('Sayerlack PU Wood Varnish Gloss 1L');
  const pBrush15 = subMap.get('Harris Classic Paint Brush 1.5-inch');

  if (pDuluxWS && pVarnish) {
    const qt1 = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'QUOTATION',
        wholesale: false,
        customerName: 'Green Garden Hotel Project',
        customerPhone: '0783344556',
        lines: [
          { kind: 'BATCH', subProductId: pDuluxWS.id, qty: '4' },
          { kind: 'BATCH', subProductId: pVarnish.id, qty: '3' },
          ...(pBrush15 ? [{ kind: 'BATCH', subProductId: pBrush15.id, qty: '4' }] : [])
        ],
        print: false
      })
    });
    console.log(`✓ Quotation 1 created: ${qt1.no} · Green Garden Hotel · Rs. ${qt1.netTotal}`);
  }

  // 3. Add Cash Movements for Today's Shift
  console.log('\n--- Adding Cash Movements ---');
  const reasonsRes = await api('/api/values/reasons');
  const reasonMap = new Map(reasonsRes.items.map(r => [r.name.toLowerCase(), r.id]));

  const rTopup = reasonMap.get('float top-up');
  const rPetty = reasonMap.get('petty expense');

  if (rTopup) {
    await api('/api/shifts/current/cash', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'IN',
        amount: '5000',
        reasonId: rTopup,
        note: 'Added morning float and small change'
      })
    });
    console.log('✓ Cash IN: Rs. 5,000 (Float top-up)');
  }

  if (rPetty) {
    await api('/api/shifts/current/cash', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'OUT',
        amount: '850',
        reasonId: rPetty,
        note: 'Tea, snacks and drinking water for staff'
      })
    });
    console.log('✓ Cash OUT: Rs. 850 (Petty expense)');
  }

  // 4. Print Today's Summary
  const status = await api('/api/billing/status');
  console.log('\n=============================================');
  console.log('🎉 DUMMY DATA SET SUCCESSFULLY CREATED!');
  console.log('=============================================');
  console.log(`Bills Today: ${status.today.bills}`);
  console.log(`Sales Today: Rs. ${status.today.total}`);
  console.log(`Next Invoice No: ${status.nextNumbers.INVOICE}`);
  console.log(`Next Quotation No: ${status.nextNumbers.QUOTATION}`);
  console.log('Total Products: 24 (all stocked across top brands & categories)');
  console.log('=============================================\n');
}

main().catch(err => {
  console.error('Error adding dummy data:', err);
  process.exit(1);
});
