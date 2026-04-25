const ALPACA_KEY    = 'PKFU6MJS2V6HW3GMI4H5LVPX4Y';
const ALPACA_SECRET = '9KEdGyUZrpQzsCgP4Y5Y2nKpiJHK7KhaGv865fn2t23y';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // Support switching options ticker — default to GLD
    const optTicker = (req.query && req.query.opt) || 'GLD';
    const optEncoded = encodeURIComponent(optTicker);

    const [gldRes, gcRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+optEncoded+'?interval=1d&range=1d'),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+optEncoded+'?interval=1d&range=1d')
    ]);
    const gldData    = await gldRes.json();
    const gldPrice   = gldData.chart.result[0].meta.regularMarketPrice;
    // For GLD gold futures multiply by ~11, for others use 1:1
    const isGold     = optTicker === 'GLD';
    const gcPrice    = isGold
      ? (await (await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d')).json()).chart.result[0].meta.regularMarketPrice
      : gldPrice;
    const goldPrice  = gcPrice;
    const multiplier = isGold ? (gcPrice / gldPrice) : 1;

    const expiry    = getNextFriday();
    const expiryStr = expiry.toISOString().split('T')[0];
    const daysLeft  = Math.ceil((expiry - new Date()) / (1000*60*60*24));

    const alpRes = await fetch(
      'https://data.alpaca.markets/v1beta1/options/snapshots/'+optTicker+'?expiration_date='+expiryStr+'&limit=1000',
      { headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET } }
    );
    if (!alpRes.ok) throw new Error('Alpaca error ' + alpRes.status);

    const data      = await alpRes.json();
    const snapshots = data.snapshots || {};

    let calls = {}, puts = {}, totalCallOI = 0, totalPutOI = 0;
    let callGreeks = {}, putGreeks = {};

    Object.entries(snapshots).forEach(([sym, snap]) => {
      const oi = snap.openInterest || snap.open_interest ||
        (snap.latestQuote && snap.latestQuote.oi) || 0;

      let strike = snap.details ? snap.details.strikePrice : null;
      let type   = snap.details ? snap.details.optionType  : null;

      if (!strike || !type) {
        const m = sym.match(/([CP])(\d{8})$/);
        if (m) { type = m[1]==='C'?'call':'put'; strike = parseInt(m[2])/1000; }
      }
      if (!strike || !type) return;

      const weight = oi > 0 ? oi : 1;
      const gamma  = snap.greeks ? (snap.greeks.gamma || 0) : 0;
      const delta  = snap.greeks ? (snap.greeks.delta || 0) : 0;
      const iv     = snap.impliedVolatility || (snap.greeks ? snap.greeks.iv : 0) || 0;

      if (type === 'call') {
        calls[strike] = (calls[strike] || 0) + weight;
        totalCallOI  += weight;
        if (!callGreeks[strike]) callGreeks[strike] = { gamma:0, delta:0, iv:0, count:0 };
        callGreeks[strike].gamma += gamma * weight;
        callGreeks[strike].delta += delta * weight;
        callGreeks[strike].iv    += iv * weight;
        callGreeks[strike].count += weight;
      } else {
        puts[strike]  = (puts[strike]  || 0) + weight;
        totalPutOI   += weight;
        if (!putGreeks[strike]) putGreeks[strike] = { gamma:0, delta:0, iv:0, count:0 };
        putGreeks[strike].gamma += gamma * weight;
        putGreeks[strike].delta += delta * weight;
        putGreeks[strike].iv    += iv * weight;
        putGreeks[strike].count += weight;
      }
    });

    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    const callEntries = Object.entries(calls).map(([s,oi]) => ({ strike:parseFloat(s), oi })).sort((a,b)=>a.strike-b.strike);
    const putEntries  = Object.entries(puts).map(([s,oi])  => ({ strike:parseFloat(s), oi })).sort((a,b)=>a.strike-b.strike);
    const callsAbove  = callEntries.filter(c=>c.strike>=gldPrice).sort((a,b)=>b.oi-a.oi);
    const putsBelow   = putEntries.filter(p=>p.strike<=gldPrice).sort((a,b)=>b.oi-a.oi);
    const maxPain     = calcMaxPain(calls, puts);

    // ── GEX by strike (Gamma * OI * 100 * spot) ────────────────
    // GEX = gamma * OI * contract_multiplier * spot_price
    // Positive GEX from calls, negative from puts
    const allStrikes = [...new Set([...callEntries.map(c=>c.strike),...putEntries.map(p=>p.strike)])].sort((a,b)=>a-b);

    const gexByStrike = allStrikes.map(s => {
      const cg = callGreeks[s] ? callGreeks[s].gamma / Math.max(callGreeks[s].count,1) : 0;
      const pg = putGreeks[s]  ? putGreeks[s].gamma  / Math.max(putGreeks[s].count,1)  : 0;
      const coi = calls[s] || 0;
      const poi = puts[s]  || 0;
      // GEX in $ millions
      const gex = ((cg * coi) - (pg * poi)) * 100 * gldPrice / 1e6;
      return {
        strike:        s,
        futuresStrike: parseFloat((s * multiplier).toFixed(0)),
        gex:           parseFloat(gex.toFixed(3)),
        callOI:        coi,
        putOI:         poi,
        callGamma:     parseFloat(cg.toFixed(6)),
        putGamma:      parseFloat(pg.toFixed(6))
      };
    });

    // ── OI chart data — strikes within 15% of current price ────
    const oiStrikes = allStrikes.filter(s => s >= gldPrice*0.88 && s <= gldPrice*1.12);
    const oiChartData = oiStrikes.map(s => ({
      strike:        s,
      futuresStrike: parseFloat((s * multiplier).toFixed(0)),
      callOI:        calls[s] || 0,
      putOI:         puts[s]  || 0
    }));

    // ── Near strikes for existing strikes panel ─────────────────
    const below       = allStrikes.filter(s=>s<=gldPrice).slice(-6);
    const above       = allStrikes.filter(s=>s> gldPrice).slice(0,6);
    const strikeData  = [...below,...above].map(s=>({
      strike:s,
      futuresStrike:parseFloat((s*multiplier).toFixed(0)),
      callOI:calls[s]||0,
      putOI:puts[s]||0
    }));

    res.status(200).json({
      pcr:        parseFloat(pcr.toFixed(2)),
      totalCallOI, totalPutOI,
      callWall:   callsAbove.length>0 ? (callsAbove[0].strike*multiplier).toFixed(0) : null,
      callWallOI: callsAbove.length>0 ? callsAbove[0].oi : 0,
      putWall:    putsBelow.length >0 ? (putsBelow[0].strike *multiplier).toFixed(0) : null,
      putWallOI:  putsBelow.length >0 ? putsBelow[0].oi  : 0,
      maxPain:    maxPain ? (maxPain*multiplier).toFixed(0) : null,
      gldPrice, goldPrice,
      multiplier: parseFloat(multiplier.toFixed(4)),
      expiry:     expiry.toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      daysLeft,
      strikes:    strikeData,
      gexByStrike,
      oiChartData
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

function getNextFriday() {
  const d = new Date();
  while (d.getDay()!==5) d.setDate(d.getDate()+1);
  return new Date(d);
}

function calcMaxPain(calls, puts) {
  const all=[...new Set([...Object.keys(calls),...Object.keys(puts)])].map(Number).sort((a,b)=>a-b);
  let minPain=Infinity, best=all[0]||0;
  all.forEach(t=>{
    let pain=0;
    Object.entries(calls).forEach(([s,oi])=>{const st=parseFloat(s);if(t>st)pain+=(t-st)*oi;});
    Object.entries(puts).forEach(([s,oi]) =>{const st=parseFloat(s);if(t<st)pain+=(st-t)*oi;});
    if(pain<minPain){minPain=pain;best=t;}
  });
  return best;
}
