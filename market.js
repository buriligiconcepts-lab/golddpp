module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    const ticker = (req.query && req.query.ticker) || 'GC=F';
    const encoded = encodeURIComponent(ticker);

    const [priceRes, dxyRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+encoded+'?interval=1d&range=2d'),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=2d')
    ]);
    const priceData = await priceRes.json();
    const dxyData   = await dxyRes.json();

    const pq = priceData.chart.result[0];
    const dq = dxyData.chart.result[0];

    res.status(200).json({
      gold: {
        price: pq.meta.regularMarketPrice,
        prev:  pq.meta.previousClose || pq.meta.chartPreviousClose,
        high:  pq.meta.regularMarketDayHigh,
        low:   pq.meta.regularMarketDayLow,
        ticker
      },
      dxy: {
        price: dq.meta.regularMarketPrice,
        prev:  dq.meta.previousClose || dq.meta.chartPreviousClose
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
