import React, { useState, useEffect, useMemo } from 'react';

/* ==========================================================================
   FLEXIBLE DESTINATION FLIGHT FINDER
   Pick an origin + a date range, see every reachable destination sorted by
   price. Search is on-demand only (no background/scheduled checks, no push
   notifications — see spec non-goals).
   ========================================================================== */

const C = {
  bg: '#F4F7F5', card: '#FFFFFF', line: '#DCE4DF', ink: '#13332E',
  muted: '#5B7A72', accent: '#0F6B5C', accentInk: '#FFFFFF',
  warn: '#8A5A00', warnBg: '#FFF3DC', chip: '#E7F1EE',
};

const inputStyle = {
  width: '100%', padding: '9px 10px', borderRadius: 8,
  border: `1px solid ${C.line}`, background: C.card, color: C.ink,
  font: 'inherit', fontSize: 14, boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4 };
const fieldWrap = { marginBottom: 12 };
const btnPrimary = {
  padding: '10px 18px', borderRadius: 8, border: 'none',
  background: C.accent, color: C.accentInk, fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const btnGhost = {
  padding: '6px 10px', borderRadius: 7, border: `1px solid ${C.line}`,
  background: C.card, color: C.ink, fontSize: 12, cursor: 'pointer',
};

const SAVED_AIRPORTS_KEY = 'flightFinder.savedAirports';
const MAX_SAVED = 2;

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_AIRPORTS_KEY)) || []; } catch { return []; }
}
function saveSaved(list) {
  try { localStorage.setItem(SAVED_AIRPORTS_KEY, JSON.stringify(list)); } catch { /* best effort */ }
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthValue(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtMoney(n, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}
function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function App() {
  const [origin, setOrigin] = useState('');
  const [savedAirports, setSavedAirports] = useState(loadSaved);
  const [travelers, setTravelers] = useState(2);
  const [maxBudget, setMaxBudget] = useState('');
  const [dateMode, setDateMode] = useState('range'); // 'range' | 'month'
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState('');
  const [month, setMonth] = useState(monthValue(1));
  const [tripLengthMin, setTripLengthMin] = useState(5);
  const [tripLengthMax, setTripLengthMax] = useState(7);
  const [kidFriendlyOnly, setKidFriendlyOnly] = useState(false);
  const [sortBy, setSortBy] = useState('price');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState(null); // { provider, asOf, results, disclaimer }

  useEffect(() => saveSaved(savedAirports), [savedAirports]);

  const originValid = /^[A-Za-z]{3}$/.test(origin);

  async function runSearch() {
    if (!originValid) { setError('Enter a 3-letter origin airport code (e.g. CVG).'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: origin.toUpperCase(),
          travelers: Number(travelers) || 1,
          maxBudget: maxBudget ? Number(maxBudget) : null,
          dateMode,
          startDate, endDate,
          month,
          tripLengthMin: Number(tripLengthMin) || undefined,
          tripLengthMax: Number(tripLengthMax) || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
      setResponse(data);
    } catch (e) {
      setError(String(e.message || e));
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

  function addSavedAirport() {
    if (!originValid) return;
    const code = origin.toUpperCase();
    if (savedAirports.includes(code)) return;
    setSavedAirports([code, ...savedAirports].slice(0, MAX_SAVED));
  }
  function removeSavedAirport(code) {
    setSavedAirports(savedAirports.filter((c) => c !== code));
  }

  const results = useMemo(() => {
    if (!response) return [];
    let list = response.results;
    if (kidFriendlyOnly) list = list.filter((r) => r.kidFriendly);
    list = [...list];
    if (sortBy === 'price') list.sort((a, b) => a.priceTotal - b.priceTotal);
    else if (sortBy === 'city') list.sort((a, b) => a.city.localeCompare(b.city));
    else if (sortBy === 'date') list.sort((a, b) => a.outboundDate.localeCompare(b.outboundDate));
    return list;
  }, [response, kidFriendlyOnly, sortBy]);

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 16px 60px' }}>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24 }}>Flexible Destination Flight Finder</h1>
          <p style={{ margin: '4px 0 0', color: C.muted, fontSize: 14 }}>
            "We don't care where, just find the best deal." Enter an origin and a date range —
            see every reachable destination, cheapest first.
          </p>
        </header>

        <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
            <div style={fieldWrap}>
              <label style={labelStyle}>Origin airport</label>
              <input
                style={inputStyle} value={origin} maxLength={3} placeholder="CVG"
                onChange={(e) => setOrigin(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              />
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {savedAirports.map((code) => (
                  <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: C.chip, borderRadius: 999, padding: '2px 4px 2px 10px', fontSize: 12 }}>
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', color: C.accent }} onClick={() => setOrigin(code)}>{code}</button>
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.muted, padding: '0 4px' }} onClick={() => removeSavedAirport(code)} aria-label={`Remove ${code}`}>×</button>
                  </span>
                ))}
                {originValid && !savedAirports.includes(origin.toUpperCase()) && savedAirports.length < MAX_SAVED && (
                  <button style={btnGhost} onClick={addSavedAirport}>+ Save {origin.toUpperCase()}</button>
                )}
              </div>
            </div>

            <div style={fieldWrap}>
              <label style={labelStyle}>Travelers</label>
              <input style={inputStyle} type="number" min={1} max={9} value={travelers} onChange={(e) => setTravelers(e.target.value)} />
            </div>

            <div style={fieldWrap}>
              <label style={labelStyle}>Max budget (total, optional)</label>
              <input style={inputStyle} type="number" min={0} placeholder="no limit" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
            </div>
          </div>

          <div style={{ ...fieldWrap, marginTop: 4 }}>
            <label style={labelStyle}>When</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button style={{ ...btnGhost, ...(dateMode === 'range' ? { background: C.accent, color: C.accentInk, border: 'none' } : {}) }} onClick={() => setDateMode('range')}>Specific dates</button>
              <button style={{ ...btnGhost, ...(dateMode === 'month' ? { background: C.accent, color: C.accentInk, border: 'none' } : {}) }} onClick={() => setDateMode('month')}>Anytime in a month</button>
            </div>

            {dateMode === 'range' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Earliest departure</label>
                  <input style={inputStyle} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Latest return (optional)</label>
                  <input style={inputStyle} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
              </div>
            ) : (
              <input style={{ ...inputStyle, maxWidth: 220 }} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12, maxWidth: 320 }}>
              <div>
                <label style={labelStyle}>Trip length min (days)</label>
                <input style={inputStyle} type="number" min={1} value={tripLengthMin} onChange={(e) => setTripLengthMin(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Trip length max (days)</label>
                <input style={inputStyle} type="number" min={1} value={tripLengthMax} onChange={(e) => setTripLengthMax(e.target.value)} />
              </div>
            </div>
          </div>

          <button style={btnPrimary} onClick={runSearch} disabled={loading}>
            {loading ? 'Searching…' : 'Find destinations'}
          </button>
          {error && <div style={{ marginTop: 10, color: '#B3261E', fontSize: 13 }}>{error}</div>}
        </section>

        {response && response.provider === 'mock' && (
          <div style={{ background: C.warnBg, color: C.warn, border: '1px solid #F0DCA8', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
            <strong>Demo data:</strong> {response.disclaimer} Set <code>FLIGHT_PROVIDER</code> to a real provider once one is wired up (see README).
          </div>
        )}
        {response && response.provider !== 'mock' && (
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>
            Prices as of {new Date(response.asOf).toLocaleString()}. {response.disclaimer}
          </div>
        )}

        {response && (
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 13, color: C.muted }}>{results.length} destination{results.length === 1 ? '' : 's'}</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <input type="checkbox" checked={kidFriendlyOnly} onChange={(e) => setKidFriendlyOnly(e.target.checked)} />
                  Kid-friendly only
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  Sort by
                  <select style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    <option value="price">Price</option>
                    <option value="city">City</option>
                    <option value="date">Departure date</option>
                  </select>
                </label>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              {results.map((r) => (
                <ResultCard key={r.code} r={r} travelers={Number(travelers) || 1} />
              ))}
              {results.length === 0 && (
                <div style={{ color: C.muted, fontSize: 14, padding: '20px 0' }}>No destinations match your filters.</div>
              )}
            </div>
          </section>
        )}

        <footer style={{ marginTop: 40, fontSize: 12, color: C.muted, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          Prices shown are "best available as of this search," not a guarantee at checkout. Search runs
          on demand only — no background price tracking or notifications.
        </footer>
      </div>
    </div>
  );
}

function ResultCard({ r, travelers }) {
  const perPerson = travelers > 1 ? r.priceTotal / travelers : null;
  return (
    <a
      href={r.bookingUrl} target="_blank" rel="noreferrer"
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px',
        textDecoration: 'none', color: 'inherit',
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          {r.city} <span style={{ color: C.muted, fontWeight: 500 }}>({r.code})</span>
          {r.kidFriendly && (
            <span style={{ marginLeft: 8, fontSize: 11, background: C.chip, color: C.accent, borderRadius: 999, padding: '2px 8px', fontWeight: 700 }}>
              Kid-friendly
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
          {fmtDate(r.outboundDate)} → {fmtDate(r.returnDate)} · {r.stops === 0 ? 'Nonstop' : `${r.stops} stop${r.stops > 1 ? 's' : ''}`}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: C.accent }}>{fmtMoney(r.priceTotal, r.currency)}</div>
        {perPerson && <div style={{ fontSize: 12, color: C.muted }}>{fmtMoney(perPerson, r.currency)}/person</div>}
      </div>
    </a>
  );
}
