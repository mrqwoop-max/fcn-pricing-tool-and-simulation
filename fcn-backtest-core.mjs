const MS_DAY = 24 * 60 * 60 * 1000;

export function optionalNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d;
}

export function iso(date) {
  return date.toISOString().slice(0, 10);
}

export function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function percentile(values, p) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Compute 126-day (≈6M) annualized realized volatility for a single price series at a given issue date.
// Uses up to 127 prices before issueDate → 126 daily log returns, annualized by √252.
// 126 trading days ≈ 6 calendar months, matching the tenor of FCN implied vol pricing reference.
function realizedVol126(series, issueDate, commonDates) {
  const pre = commonDates.filter(d => d < issueDate);
  if (pre.length < 10) return null;
  const window = pre.slice(-127); // 127 prices → 126 log returns ≈ 6M
  const prices = window.map(d => series.get(d)).filter(p => p > 0);
  if (prices.length < 10) return null;
  const logR = [];
  for (let i = 1; i < prices.length; i++) {
    const r = Math.log(prices[i] / prices[i - 1]);
    if (Number.isFinite(r)) logR.push(r);
  }
  if (logR.length < 5) return null;
  const mean = logR.reduce((s, r) => s + r, 0) / logR.length;
  // Bessel's correction: divide by (n-1) for sample variance
  const variance = logR.reduce((s, r) => s + (r - mean) ** 2, 0) / (logR.length > 1 ? logR.length - 1 : logR.length);
  return Math.sqrt(variance * 252);
}

// Aggregate backtest stats for a subset of paths (one vol regime bucket).
function volRegimeStats(regimePaths) {
  if (!regimePaths.length) return null;
  const koPaths = regimePaths.filter(p => p.koDate);
  const assignedPaths = regimePaths.filter(p => p.assigned);
  const cashPaths = regimePaths.filter(p => !p.koDate && !p.assigned);
  const issueDates = regimePaths.map(p => p.issueDate).sort();
  const vols = regimePaths.map(p => p.volAtIssue).filter(Number.isFinite);
  return {
    n: regimePaths.length,
    koRate: koPaths.length / regimePaths.length,
    assignmentRate: assignedPaths.length / regimePaths.length,
    cashRate: cashPaths.length / regimePaths.length,
    avgHoldingDays: average(regimePaths.map(p => p.holdingDays)),
    avgTotalReturn: average(regimePaths.map(p => p.totalReturn)),
    avgCouponReturn: average(regimePaths.map(p => p.couponReturn)),
    expectedAssignmentLoss: assignedPaths.reduce((s, p) => s + Math.min(p.totalReturn, 0), 0) / regimePaths.length,
    dateStart: issueDates[0],
    dateEnd: issueDates[issueDates.length - 1],
    volMean: average(vols),
    volMin: vols.length ? Math.min(...vols) : null,
    volMax: vols.length ? Math.max(...vols) : null,
  };
}

function toStooqSymbol(yahooTicker) {
  const t = String(yahooTicker).trim().toUpperCase();
  if (t.endsWith('.T')) return t.replace(/\.T$/, '.JP').toLowerCase();
  return t.toLowerCase() + '.us';
}

export async function fetchStooqAdjustedClose(ticker, { startYear = 2010 } = {}) {
  const sym = toStooqSymbol(ticker);
  const d1 = `${startYear}0101`;
  const now = new Date();
  const d2 = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const url = `https://stooq.com/q/d/l/?s=${sym}&d1=${d1}&d2=${d2}&i=d`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${ticker}: Stooq HTTP ${response.status}`);
  const text = await response.text();
  if (!text || text.trim() === '' || text.includes('No data')) {
    throw new Error(`${ticker}: no Stooq data`);
  }
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error(`${ticker}: Stooq CSV too short`);
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const closeIdx = header.indexOf('close');
  if (dateIdx < 0 || closeIdx < 0) throw new Error(`${ticker}: unexpected Stooq CSV format`);
  const series = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[dateIdx]?.trim();
    const close = parseFloat(cols[closeIdx]);
    if (dateStr && Number.isFinite(close)) series.set(dateStr, close);
  }
  if (!series.size) throw new Error(`${ticker}: Stooq returned empty series`);
  return series;
}

export async function fetchAdjustedClose(ticker, { startYear = 2010 } = {}) {
  // Try Yahoo Finance first (server-side, no CORS issues)
  try {
    const start = Math.floor(Date.UTC(startYear, 0, 1) / 1000);
    const end = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d&events=history&includeAdjustedClose=true`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 fcn-backtest" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${ticker}: HTTP ${response.status}`);
    const payload = await response.json();
    const result = payload.chart?.result?.[0];
    if (!result) throw new Error(`${ticker}: no chart result`);

    const timestamps = result.timestamp || [];
    const adj = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
    const series = new Map();
    for (let i = 0; i < timestamps.length; i += 1) {
      if (Number.isFinite(adj[i])) series.set(iso(new Date(timestamps[i] * 1000)), adj[i]);
    }
    if (!series.size) throw new Error(`${ticker}: Yahoo returned empty series`);
    return series;
  } catch (yahooErr) {
    // Fallback to Stooq (CORS-friendly, works from browser too)
    console.warn(`[backtest] Yahoo failed for ${ticker} (${yahooErr.message}), trying Stooq...`);
    return fetchStooqAdjustedClose(ticker, { startYear });
  }
}

export function nearestDateOnOrAfter(dates, targetIso) {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates[mid] >= targetIso) {
      ans = dates[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export function observationStartMonths(product) {
  const guaranteed = Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths);
  if (Number.isFinite(guaranteed) && guaranteed > 0) return Math.floor(guaranteed) + 1;
  const explicitStart = Number(product.observationStartMonths);
  return Number.isFinite(explicitStart) && explicitStart > 0 ? Math.floor(explicitStart) : 1;
}

export function observationDates(product, commonDates, issueDate, maturityDate) {
  if (!productHasKo(product)) return [];
  const issue = new Date(`${issueDate}T00:00:00.000Z`);
  const startMonths = observationStartMonths(product);
  if (usesPeriodObservation(product)) {
    const dates = [];
    for (let month = startMonths; month <= product.tenorMonths; month += 1) {
      const obs = nearestDateOnOrAfter(commonDates, iso(addMonths(issue, month)));
      if (obs && obs <= maturityDate) dates.push(obs);
    }
    return dates;
  }

  const firstObservationDate = nearestDateOnOrAfter(commonDates, iso(addMonths(issue, startMonths)));
  if (!firstObservationDate || firstObservationDate > maturityDate) return [];
  return commonDates.filter((date) => date >= firstObservationDate && date <= maturityDate);
}

export function periodEndDates(product, commonDates, issueDate, maturityDate) {
  const issue = new Date(`${issueDate}T00:00:00.000Z`);
  const dates = [];
  for (let month = 1; month <= product.tenorMonths; month += 1) {
    const obs = nearestDateOnOrAfter(commonDates, iso(addMonths(issue, month)));
    if (obs && obs <= maturityDate) dates.push(obs);
  }
  return [...new Set(dates)];
}

export function koStepIndexFor(product, issueDate, observationDate, obsIndex = 0) {
  if (!product.koStep) return 0;
  if (!issueDate || !observationDate) return Math.max(0, Math.floor(Number(obsIndex) || 0));
  const issue = new Date(`${issueDate}T00:00:00.000Z`);
  const startMonths = observationStartMonths(product);
  const tenor = Math.max(startMonths, Math.floor(Number(product.tenorMonths) || startMonths));
  let stepIndex = 0;
  for (let month = startMonths; month <= tenor; month += 1) {
    if (observationDate >= iso(addMonths(issue, month))) {
      stepIndex = month - startMonths;
    } else {
      break;
    }
  }
  return stepIndex;
}

export function koBarrierFor(product, stepIndex = 0) {
  if (!productHasKo(product)) return null;
  if (!product.koStep) return product.ko;
  return Math.max(0, product.ko - product.koStep * Math.max(0, Math.floor(Number(stepIndex) || 0)));
}

export function isMemoryKo(product) {
  if (isBonusEnhance(product)) return false;
  if (isTwinwinLike(product)) return false;
  return /memory/i.test(`${product.koType || ""} ${productDescription(product)}`);
}

export function isRangeAccrual(product) {
  return /wra|range/i.test(`${product.productType || ""} ${product.name || ""} ${product.product || ""}`);
}

export function productDescription(product) {
  return `${product.productType || ""} ${product.name || ""} ${product.product || ""}`.toUpperCase();
}

export function isBonusEnhance(product) {
  return /(?:\bBP\b|BEN|BONUS)/.test(productDescription(product));
}

export function isTwinwinLike(product) {
  const text = productDescription(product);
  return !/SUPERBULL/.test(text) && /(?:BULL|BEAR|TWIN)/.test(text);
}

export function usesPeriodObservation(product) {
  const text = productDescription(product);
  const koType = String(product.koType || "");
  const combined = `${text} ${koType}`;
  if (/MKO/i.test(combined) && !/DKO/i.test(combined)) return true;
  if (/DKO|DAILY/i.test(combined) && !isBonusEnhance(product) && !isTwinwinLike(product)) return false;
  return isBonusEnhance(product) || isTwinwinLike(product) || /period|month|end/i.test(koType);
}

export function productHasKo(product) {
  const ko = optionalNumber(product.ko);
  return Number.isFinite(ko) && ko > 0;
}

export function unsupportedBacktestProductReason(product) {
  const text = productDescription(product);
  if (/SUPERBULL/.test(text)) return "Superbull payoff is not implemented yet.";
  return "";
}

export function validateBacktestProduct(product) {
  const unsupported = unsupportedBacktestProductReason(product);
  if (unsupported) return unsupported;
  if (downsideBarrier(product) && knockInStyle(product) === "UNKNOWN") {
    return "KI Barrier is present, but Barrier Type must state AKI or EKI. I will not guess the monitoring style.";
  }
  if (isTwinwinLike(product) && !downsideBarrier(product)) {
    return "Twinwin / Bull Bear requires a KI Barrier / lower trigger for the reviewed EKI payoff; AKI is blocked until an AKI termsheet is reviewed.";
  }
  if (isTwinwinLike(product) && knockInStyle(product) === "AKI") {
    return "Twinwin / Bull Bear AKI payoff has not been verified from the reviewed DBS product description. Provide an AKI termsheet before backtesting.";
  }
  if (!isBonusEnhance(product) && !productHasKo(product)) {
    return "KO Barrier is required for this product type.";
  }
  return "";
}


export function annualizedRateReturn(product, holdingDays) {
  return (Number(product.coupon) || 0) * (holdingDays / 365);
}

export function rateBasisFor(product) {
  const explicit = String(product.rateBasis || "").trim().toUpperCase();
  if (/^(?:PA|P\.A\.|ANNUAL|ANNUALIZED|年化)$/.test(explicit)) return "annual";
  if (/^(?:PERIOD|TERM|ABSOLUTE|期|期間)$/.test(explicit)) return "period";
  if (isBonusEnhance(product)) return "period";
  return "annual";
}

export function rateReturn(product, rate, holdingDays, issueDate, eventDate, { integerMonths = false } = {}) {
  const value = Number(rate) || 0;
  if (rateBasisFor(product) === "period") return value;
  if (integerMonths && issueDate && eventDate) {
    return value * (observationMonthBucket(issueDate, eventDate, product.tenorMonths) / 12);
  }
  return value * (holdingDays / 365);
}

export function koInterestReturn(product, issueDate, koDate, holdingDays) {
  const rate = optionalNumber(product.koInterestRate) ?? Number(product.coupon);
  return rateReturn(product, rate, holdingDays, issueDate, koDate, { integerMonths: isTwinwinLike(product) });
}

export function bonusRateReturn(product, holdingDays) {
  const rate = optionalNumber(product.bonusRate) ?? Number(product.coupon);
  return rateReturn(product, rate, holdingDays);
}

export function bonusCouponReturn(product, holdingDays) {
  const flatBonus = optionalNumber(product.bonusCoupon);
  if (flatBonus != null) return flatBonus;
  return bonusRateReturn(product, holdingDays);
}

export function bonusCouponBarrier(product) {
  const barrier = optionalNumber(product.couponBarrier);
  return Number.isFinite(barrier) && barrier > 0 ? barrier : product.strike;
}


export function knockInStyle(product) {
  const text = `${product.barrierType || ""} ${product.kiType || ""} ${product.productType || ""} ${product.name || ""} ${product.product || ""}`.toUpperCase();
  if (/(?:NKI|NO\s*KI|NO\s*KNOCK\s*IN|NONE)/.test(text)) return "NKI";
  if (/(?:AKI|AMERICAN)/.test(text)) return "AKI";
  if (/(?:EKI|EUROPEAN)/.test(text)) return "EKI";
  return downsideBarrier(product) ? "UNKNOWN" : "NKI";
}

export function isAmericanTrigger(product) {
  return knockInStyle(product) === "AKI";
}

export function lowerTriggerEvent(product, finalWorst, minWorst) {
  const barrier = downsideBarrier(product);
  if (!barrier) return false;
  const style = knockInStyle(product);
  if (style === "AKI") return minWorst <= barrier;
  if (style === "EKI") return finalWorst <= barrier;
  return false;
}

export function fcnDownsideApplies(product, finalWorst, minWorst) {
  if (finalWorst >= product.strike) return false;
  const style = knockInStyle(product);
  if (style === "AKI" || style === "EKI") return lowerTriggerEvent(product, finalWorst, minWorst);
  return true;
}

export function bonusPerformanceMaturityDetail(product, finalWorst, holdingDays) {
  const putStrike = Number(product.strike);
  const couponBarrier = bonusCouponBarrier(product);
  const participationRate = optionalNumber(product.participationRate) ?? 1;

  if (finalWorst < putStrike) {
    return {
      settlement: "physical",
      bonusEligible: false,
      bonusReturn: 0,
      participationReturn: 0,
      totalReturn: finalWorst - 1,
    };
  }

  if (finalWorst < couponBarrier) {
    return {
      settlement: "cash",
      bonusEligible: false,
      bonusReturn: 0,
      participationReturn: 0,
      totalReturn: 0,
    };
  }

  const bonusReturn = bonusCouponReturn(product, holdingDays);
  const participationReturn = participationRate * Math.max(0, finalWorst - 1);
  return {
    settlement: "cash",
    bonusEligible: true,
    bonusReturn,
    participationReturn,
    totalReturn: Math.max(bonusReturn, participationReturn),
  };
}

export function bonusPerformanceMaturityReturn(product, finalWorst, holdingDays) {
  return bonusPerformanceMaturityDetail(product, finalWorst, holdingDays).totalReturn;
}


export function twinwinMaturityReturn(product, finalWorst, minWorst) {
  return lowerTriggerEvent(product, finalWorst, minWorst)
    ? Math.min(0, finalWorst - 1)
    : Math.abs(finalWorst - 1);
}

export function maturityPayoffReturn(product, { finalWorst, minWorst, couponReturn, holdingDays }) {
  if (isBonusEnhance(product)) return bonusPerformanceMaturityReturn(product, finalWorst, holdingDays);
  if (isTwinwinLike(product)) return twinwinMaturityReturn(product, finalWorst, minWorst);
  // FCN/WRA: if KI triggered and finalWorst < strike, investor receives stock at strike (loss)
  if (fcnDownsideApplies(product, finalWorst, minWorst)) return (finalWorst - 1) + couponReturn;
  // KI not triggered (or finalWorst >= strike for NKI): principal returned, coupon only
  return Number.isFinite(couponReturn) ? couponReturn : annualizedRateReturn(product, holdingDays);
}

export function couponReturnForPath(product, series, issuePrices, commonDates, issueDate, endDate, options = {}) {
  const holdingDays = Math.max(1, Math.round((new Date(`${endDate}T00:00:00.000Z`) - new Date(`${issueDate}T00:00:00.000Z`)) / MS_DAY));
  if (isTwinwinLike(product)) {
    return options.koDate ? koInterestReturn(product, issueDate, endDate, holdingDays) : 0;
  }
  if (isBonusEnhance(product)) {
    return options.koDate ? koInterestReturn(product, issueDate, endDate, holdingDays) : 0;
  }
  return periodCouponReturn(product, series, issuePrices, commonDates, issueDate, endDate);
}

export function periodCouponReturn(product, series, issuePrices, commonDates, issueDate, endDate) {
  const maturityDate = nearestDateOnOrAfter(commonDates, iso(addMonths(new Date(`${issueDate}T00:00:00.000Z`), product.tenorMonths))) || endDate;
  const periodEnds = periodEndDates(product, commonDates, issueDate, maturityDate);
  const periodRate = (Number(product.coupon) || 0) / 12;
  if (!periodEnds.length || !periodRate) return 0;
  const rangeLower = optionalNumber(product.rangeLower) ?? product.strike;
  const rangeUpper = optionalNumber(product.rangeUpper) ?? Infinity;
  let previousEnd = issueDate;
  let total = 0;

  for (let i = 0; i < periodEnds.length; i += 1) {
    const periodEnd = periodEnds[i];
    const periodDates = commonDates.filter((date) => date > previousEnd && date <= periodEnd);
    if (!periodDates.length) {
      previousEnd = periodEnd;
      continue;
    }
    const accruedDates = periodDates.filter((date) => date <= endDate);
    if (accruedDates.length) {
      if (!isRangeAccrual(product)) {
        total += periodRate * (accruedDates.length / periodDates.length);
      } else if (i === 0) {
        total += periodRate * (accruedDates.length / periodDates.length);
      } else {
        const eligibleDates = accruedDates.filter((date) => {
          const ratios = series.map((s, idx) => s.get(date) / issuePrices[idx]);
          return ratios.every((ratio) => ratio >= rangeLower && ratio <= rangeUpper);
        });
        total += periodRate * (eligibleDates.length / periodDates.length);
      }
    }
    if (endDate <= periodEnd) break;
    previousEnd = periodEnd;
  }

  return total;
}

export function stressCouponReturn(product, holdingDays, finalWorst) {
  if (isBonusEnhance(product) || isTwinwinLike(product)) return 0;
  const tenorMonths = Math.max(1, Number(product.tenorMonths) || Math.round(holdingDays / 30));
  if (!isRangeAccrual(product)) return (Number(product.coupon) || 0) * (tenorMonths / 12);
  const rangeLower = optionalNumber(product.rangeLower) ?? product.strike;
  const rangeUpper = optionalNumber(product.rangeUpper) ?? Infinity;
  const fullCoupon = (Number(product.coupon) || 0) * (tenorMonths / 12);
  const firstPeriodCoupon = (Number(product.coupon) || 0) / 12;
  return finalWorst >= rangeLower && finalWorst <= rangeUpper ? fullCoupon : firstPeriodCoupon;
}

export function observationMonthBucket(issueDate, eventDate, maxMonths = null) {
  const issue = new Date(`${issueDate}T00:00:00.000Z`);
  for (let month = 1; month <= 240; month += 1) {
    if (eventDate <= iso(addMonths(issue, month))) {
      return Number.isFinite(Number(maxMonths)) ? Math.min(month, Math.floor(Number(maxMonths))) : month;
    }
  }
  const fallback = Math.max(1, Math.ceil((new Date(`${eventDate}T00:00:00.000Z`) - issue) / (30 * MS_DAY)));
  return Number.isFinite(Number(maxMonths)) ? Math.min(fallback, Math.floor(Number(maxMonths))) : fallback;
}

export function stressScenarios(product) {
  const holdingDays = Math.max(1, Math.round(product.tenorMonths * 365 / 12));
  return [-0.10, -0.30, -0.50].map((shock) => {
    const finalWorst = 1 + shock;
    const couponReturn = stressCouponReturn(product, holdingDays, finalWorst);
    const totalReturn = maturityPayoffReturn(product, {
      finalWorst,
      minWorst: finalWorst,
      couponReturn,
      holdingDays,
    });
    return {
      shock,
      finalWorst,
      totalReturn,
      assigned: isTwinwinLike(product)
        ? lowerTriggerEvent(product, finalWorst, finalWorst)
        : isBonusEnhance(product)
          ? finalWorst < product.strike
          : fcnDownsideApplies(product, finalWorst, finalWorst),
    };
  });
}

export function downsideBarrier(product) {
  const barrier = Number(product.kiBarrier ?? product.downsideBarrier);
  return Number.isFinite(barrier) && barrier > 0 ? barrier : null;
}

export function koMilestonesFromMonthly(monthlyKo, pathsLength, tenorMonths) {
  const tenor = Math.max(1, Math.floor(Number(tenorMonths) || 1));
  const milestoneMonths = [1, 2, 3, 6].filter((month) => month <= tenor);
  return Object.fromEntries(milestoneMonths.map((month) => {
    const count = Object.entries(monthlyKo)
      .filter(([key]) => Number(key.slice(1)) <= month)
      .reduce((sum, [, value]) => sum + value, 0);
    return [`m${month}`, pathsLength ? count / pathsLength : 0];
  }));
}

export function daysToRecoverStrike({ assignedTickerSeries, issuePrice, strike, maturityDate, commonDates }) {
  const strikePrice = issuePrice * strike;
  const maturityPrice = assignedTickerSeries.get(maturityDate);
  if (Number.isFinite(maturityPrice) && maturityPrice >= strikePrice) return 0;
  for (const date of commonDates) {
    if (date <= maturityDate) continue;
    const price = assignedTickerSeries.get(date);
    if (Number.isFinite(price) && price >= strikePrice) {
      return Math.max(0, Math.round((new Date(`${date}T00:00:00.000Z`) - new Date(`${maturityDate}T00:00:00.000Z`)) / MS_DAY));
    }
  }
  return null;
}

export function seriesProfile(ticker, series) {
  const dates = [...(series?.keys?.() || [])].sort();
  return {
    ticker,
    start: dates[0] || null,
    end: dates[dates.length - 1] || null,
    points: dates.length,
  };
}

export function yearsBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  return (new Date(`${endIso}T00:00:00.000Z`) - new Date(`${startIso}T00:00:00.000Z`)) / (365 * MS_DAY);
}

export function dataQualityWarnings({ product, commonDates, paths, tickerProfiles }) {
  const warnings = [];
  const commonYears = yearsBetween(commonDates[0], commonDates[commonDates.length - 1]);
  const shortTickers = tickerProfiles.filter((profile) => yearsBetween(profile.start, profile.end) < 3);
  if (commonYears < 3) {
    warnings.push(`共同歷史僅 ${commonYears.toFixed(1)} 年，回測代表性偏低`);
  }
  if (paths.length < 500) {
    warnings.push(`有效路徑僅 ${paths.length} 條，排序信心偏低`);
  }
  if (shortTickers.length) {
    warnings.push(`短歷史標的：${shortTickers.map((profile) => `${profile.ticker} 自 ${profile.start}`).join("、")}`);
  }
  if (product.tickers.length > 1 && shortTickers.length) {
    warnings.push("含新掛牌標的時，其他標的較早的壓力期間會被共同資料區間排除");
  }
  return warnings;
}

export function backtest(product, allSeries) {
  const validation = validateBacktestProduct(product);
  if (validation) {
    const error = new Error(`${product.name || product.id}: ${validation}`);
    error.status = 400;
    throw error;
  }
  const series = product.tickers.map((ticker) => allSeries.get(ticker));
  if (series.some((item) => !item?.size)) throw new Error(`${product.name || product.id}: missing price series`);
  const tickerProfiles = product.tickers.map((ticker, index) => seriesProfile(ticker, series[index]));
  const commonDates = [...series[0].keys()].filter((date) => series.every((s) => s.has(date))).sort();
  const paths = [];
  const kiBarrier = downsideBarrier(product);

  for (const issueDate of commonDates) {
    const issue = new Date(`${issueDate}T00:00:00.000Z`);
    const maturityDate = nearestDateOnOrAfter(commonDates, iso(addMonths(issue, product.tenorMonths)));
    if (!maturityDate) continue;

    // Vol at issue: max 60-day realized vol across all underlyings (worst-of vol drives pricing)
    const volsAtIssue = series.map(s => realizedVol126(s, issueDate, commonDates));
    const volAtIssue = volsAtIssue.some(Number.isFinite)
      ? Math.max(...volsAtIssue.filter(Number.isFinite))
      : null;

    const issuePrices = series.map((s) => s.get(issueDate));
    let minWorst = Infinity;
    let finalWorst = null;
    let finalRatios = null;
    let peakWorst = -Infinity;
    let peakDate = issueDate;
    let firstBarrierTouchDate = null;
    let daysToKi = null;
    let daysFromPeakToBarrier = null;

    for (const date of commonDates) {
      if (date < issueDate || date > maturityDate) continue;
      const ratios = series.map((s, idx) => s.get(date) / issuePrices[idx]);
      const worst = Math.min(...ratios);
      minWorst = Math.min(minWorst, worst);
      if (worst > peakWorst) {
        peakWorst = worst;
        peakDate = date;
      }
      if (kiBarrier && !firstBarrierTouchDate && worst <= kiBarrier) {
        firstBarrierTouchDate = date;
        daysToKi = Math.max(0, Math.round((new Date(`${date}T00:00:00.000Z`) - issue) / MS_DAY));
        daysFromPeakToBarrier = Math.max(0, Math.round((new Date(`${date}T00:00:00.000Z`) - new Date(`${peakDate}T00:00:00.000Z`)) / MS_DAY));
      }
      if (date === maturityDate) finalWorst = worst;
      if (date === maturityDate) finalRatios = ratios;
    }

    const obsDates = observationDates(product, commonDates, issueDate, maturityDate);
    let koDate = null;
    const memoryHits = series.map(() => false);
    for (let i = 0; i < obsDates.length; i += 1) {
      const date = obsDates[i];
      const ratios = series.map((s, idx) => s.get(date) / issuePrices[idx]);
      const worst = Math.min(...ratios);
      const koBarrier = koBarrierFor(product, koStepIndexFor(product, issueDate, date, i));
      if (isMemoryKo(product)) {
        ratios.forEach((ratio, idx) => {
          if (ratio >= koBarrier) memoryHits[idx] = true;
        });
      }
      const knockedOut = isMemoryKo(product)
        ? memoryHits.every(Boolean)
        : worst >= koBarrier;
      if (knockedOut) {
        koDate = date;
        finalWorst = worst;
        break;
      }
    }

    const endDate = koDate || maturityDate;
    const holdingDays = Math.max(1, Math.round((new Date(`${endDate}T00:00:00.000Z`) - issue) / MS_DAY));
    const couponReturn = couponReturnForPath(product, series, issuePrices, commonDates, issueDate, endDate, { koDate: Boolean(koDate) });
    const koReturn = (isTwinwinLike(product) || isBonusEnhance(product))
      ? koInterestReturn(product, issueDate, endDate, holdingDays)
      : couponReturn;
    const totalReturn = koDate ? koReturn : maturityPayoffReturn(product, {
      finalWorst,
      minWorst,
      couponReturn,
      holdingDays,
    });
    const annualizedReturn = Math.pow(Math.max(0.0001, 1 + totalReturn), 365 / holdingDays) - 1;
    const kiTriggered = kiBarrier ? lowerTriggerEvent(product, finalWorst, minWorst) : false;
    const kiDate = kiTriggered
      ? (isAmericanTrigger(product) ? firstBarrierTouchDate : maturityDate)
      : null;
    const kiTriggerDays = kiTriggered
      ? Math.max(0, Math.round((new Date(`${kiDate}T00:00:00.000Z`) - issue) / MS_DAY))
      : null;
    const kiPeakToTriggerDays = kiTriggered
      ? Math.max(0, Math.round((new Date(`${kiDate}T00:00:00.000Z`) - new Date(`${peakDate}T00:00:00.000Z`)) / MS_DAY))
      : null;
    const assigned = !koDate && (isTwinwinLike(product)
      ? lowerTriggerEvent(product, finalWorst, minWorst)
      : isBonusEnhance(product)
        ? finalWorst < product.strike
        : fcnDownsideApplies(product, finalWorst, minWorst));
    const assignedIndex = assigned && Array.isArray(finalRatios)
      ? finalRatios.reduce((worstIdx, ratio, idx) => ratio < finalRatios[worstIdx] ? idx : worstIdx, 0)
      : null;
    const recoveryDaysToStrike = assigned && assignedIndex != null
      ? daysToRecoverStrike({
        assignedTickerSeries: series[assignedIndex],
        issuePrice: issuePrices[assignedIndex],
        strike: product.strike,
        maturityDate,
        commonDates,
      })
      : null;

    paths.push({
      issueDate,
      endDate,
      koDate,
      koMonth: koDate ? observationMonthBucket(issueDate, koDate, product.tenorMonths) : null,
      volAtIssue,
      holdingDays,
      finalWorst,
      minWorst,
      couponReturn,
      totalReturn,
      annualizedReturn,
      assigned,
      assignedTicker: assignedIndex != null ? product.tickers[assignedIndex] : null,
      recoveryDaysToStrike,
      kiDate,
      kiTriggered,
      touchedKi: Boolean(kiDate),
      daysToKi: isAmericanTrigger(product) ? daysToKi : kiTriggerDays,
      daysFromPeakToBarrier: isAmericanTrigger(product) ? daysFromPeakToBarrier : kiPeakToTriggerDays,
    });
  }

  if (!paths.length) throw new Error(`${product.name || product.id}: insufficient common history`);

  // Vol regime stratification: divide paths into low/mid/high vol thirds by P33/P67
  const pathVols = paths.map(p => p.volAtIssue).filter(Number.isFinite);
  const volP33 = pathVols.length >= 9 ? percentile(pathVols, 1 / 3) : null;
  const volP67 = pathVols.length >= 9 ? percentile(pathVols, 2 / 3) : null;
  // Current vol = most recent issue date with valid vol data
  const currentVol = [...paths].reverse().find(p => Number.isFinite(p.volAtIssue))?.volAtIssue ?? null;
  const volRegimes = (volP33 != null && volP67 != null) ? {
    p33: volP33,
    p67: volP67,
    currentVol,
    currentBucket: currentVol == null ? null
      : currentVol <= volP33 ? 'low'
      : currentVol <= volP67 ? 'mid'
      : 'high',
    low:  volRegimeStats(paths.filter(p => Number.isFinite(p.volAtIssue) && p.volAtIssue <= volP33)),
    mid:  volRegimeStats(paths.filter(p => Number.isFinite(p.volAtIssue) && p.volAtIssue > volP33 && p.volAtIssue <= volP67)),
    high: volRegimeStats(paths.filter(p => Number.isFinite(p.volAtIssue) && p.volAtIssue > volP67)),
  } : null;

  const koPaths = paths.filter((path) => path.koDate);
  const maturityPaths = paths.filter((path) => !path.koDate);
  const assignmentPaths = paths.filter((path) => path.assigned);
  const losses = paths.filter((path) => path.totalReturn < 0);
  const gains = paths.filter((path) => path.totalReturn > 0);
  const monthlyKo = {};
  for (const path of koPaths) {
    const month = path.koMonth || observationMonthBucket(path.issueDate, path.koDate, product.tenorMonths);
    monthlyKo[`M${month}`] = (monthlyKo[`M${month}`] || 0) + 1;
  }
  const byReturn = [...paths].sort((a, b) => b.totalReturn - a.totalReturn);
  const avgGain = average(gains.map((p) => p.totalReturn));
  const avgLoss = average(losses.map((p) => p.totalReturn));
  const expectedGain = gains.reduce((sum, path) => sum + path.totalReturn, 0) / paths.length;
  const expectedLoss = losses.reduce((sum, path) => sum + path.totalReturn, 0) / paths.length;
  const assignmentReturns = assignmentPaths.map((p) => p.totalReturn);
  const recoveredAssignmentPaths = assignmentPaths.filter((p) => Number.isFinite(p.recoveryDaysToStrike));
  const recoveryDays = recoveredAssignmentPaths.map((p) => p.recoveryDaysToStrike);
  const expectedAssignmentLoss = assignmentPaths.reduce((sum, path) => sum + Math.min(path.totalReturn, 0), 0) / paths.length;
  const avgCouponReturn = average(paths.map((p) => p.couponReturn));
  const avgTotalReturn = average(paths.map((p) => p.totalReturn));
  const riskCompensationMultiple = expectedAssignmentLoss < 0
    ? avgCouponReturn / Math.abs(expectedAssignmentLoss)
    : null;
  const returnCompensationMultiple = expectedAssignmentLoss < 0 && Number.isFinite(avgTotalReturn)
    ? avgTotalReturn / Math.abs(expectedAssignmentLoss)
    : null;
  const kiPaths = paths.filter((path) => path.kiTriggered);
  const kiLossPaths = kiPaths.filter((path) => path.totalReturn < 0);
  const koMilestones = koMilestonesFromMonthly(monthlyKo, paths.length, product.tenorMonths);

  return {
    id: product.id,
    product: product.name,
    productType: product.productType || null,
    tickers: product.tickers,
    strike: product.strike,
    ko: productHasKo(product) ? product.ko : null,
    kiBarrier,
    koStep: product.koStep || null,
    koType: productHasKo(product) ? product.koType || (usesPeriodObservation(product) ? "Monthly KO" : "Daily KO") : "No KO",
    coupon: product.coupon,
    couponBarrier: optionalNumber(product.couponBarrier),
    bonusCoupon: optionalNumber(product.bonusCoupon),
    bonusRate: optionalNumber(product.bonusRate),
    koInterestRate: optionalNumber(product.koInterestRate),
    participationRate: optionalNumber(product.participationRate),
    rateBasis: rateBasisFor(product),
    tenorMonths: product.tenorMonths,
    guaranteedPeriodMonths: Number.isFinite(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths))
      ? Math.max(0, Math.floor(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths)))
      : null,
    observationStartMonths: productHasKo(product) ? observationStartMonths(product) : null,
    sampleStart: commonDates[0],
    sampleEnd: commonDates[commonDates.length - 1],
    simulatedIssues: paths.length,
    tickerProfiles,
    dataQualityWarnings: dataQualityWarnings({ product, commonDates, paths, tickerProfiles }),
    koRate: koPaths.length / paths.length,
    assignmentRate: assignmentPaths.length / paths.length,
    monthlyKo,
    koMilestones,
    avgHoldingDays: average(paths.map((p) => p.holdingDays)),
    worstOf: {
      min: Math.min(...paths.map((p) => p.finalWorst)),
      p5: percentile(paths.map((p) => p.finalWorst), 0.05),
      p25: percentile(paths.map((p) => p.finalWorst), 0.25),
      median: percentile(paths.map((p) => p.finalWorst), 0.50),
      p75: percentile(paths.map((p) => p.finalWorst), 0.75),
      p95: percentile(paths.map((p) => p.finalWorst), 0.95),
    },
    totalReturn: {
      min: Math.min(...paths.map((p) => p.totalReturn)),
      p1: percentile(paths.map((p) => p.totalReturn), 0.01),
      p5: percentile(paths.map((p) => p.totalReturn), 0.05),
      p25: percentile(paths.map((p) => p.totalReturn), 0.25),
      median: percentile(paths.map((p) => p.totalReturn), 0.50),
      p75: percentile(paths.map((p) => p.totalReturn), 0.75),
      p95: percentile(paths.map((p) => p.totalReturn), 0.95),
    },
    maturityReturn: maturityPaths.length ? {
      min: Math.min(...maturityPaths.map((p) => p.totalReturn)),
      p1: percentile(maturityPaths.map((p) => p.totalReturn), 0.01),
      p5: percentile(maturityPaths.map((p) => p.totalReturn), 0.05),
    } : null,
    assignmentReturn: assignmentReturns.length ? {
      average: average(assignmentReturns),
      p5: percentile(assignmentReturns, 0.05),
      min: Math.min(...assignmentReturns),
    } : null,
    assignmentRecovery: assignmentPaths.length ? {
      recoveredRate: recoveredAssignmentPaths.length / assignmentPaths.length,
      unrecoveredRate: (assignmentPaths.length - recoveredAssignmentPaths.length) / assignmentPaths.length,
      averageDays: recoveryDays.length ? average(recoveryDays) : null,
      medianDays: recoveryDays.length ? percentile(recoveryDays, 0.50) : null,
      p75Days: recoveryDays.length ? percentile(recoveryDays, 0.75) : null,
      maxDays: recoveryDays.length ? Math.max(...recoveryDays) : null,
    } : null,
    winRate: paths.filter((p) => p.totalReturn >= 0).length / paths.length,
    lossRate: losses.length / paths.length,
    avgGain,
    avgLoss,
    expectedGain,
    expectedLoss,
    expectedAssignmentLoss,
    avgCouponReturn,
    riskCompensationMultiple,
    returnCompensationMultiple,
    ki: kiBarrier ? {
      barrier: kiBarrier,
      touchRate: kiPaths.length / paths.length,
      triggerRate: kiPaths.length / paths.length,
      lossAfterKiRate: kiPaths.length ? kiLossPaths.length / kiPaths.length : 0,
      fastestTouchDays: kiPaths.length ? Math.min(...kiPaths.map((p) => p.daysToKi).filter(Number.isFinite)) : null,
      fastestPeakToBarrierDays: kiPaths.length ? Math.min(...kiPaths.map((p) => p.daysFromPeakToBarrier).filter(Number.isFinite)) : null,
    } : null,
    payoffRatio: avgGain && avgLoss ? avgGain / Math.abs(avgLoss) : null,
    avgReturn: avgTotalReturn,
    avgAnnualizedReturn: average(paths.map((p) => p.annualizedReturn)),
    maximumPathDrawdown: Math.min(...paths.map((p) => p.minWorst - 1)),
    stress: stressScenarios(product),
    bestIssues: byReturn.slice(0, 5),
    worstIssues: byReturn.slice(-5).reverse(),
    volRegimes,
  };
}

export function pct(value, digits = 2) {
  return value == null || !Number.isFinite(value) ? null : `${(value * 100).toFixed(digits)}%`;
}

export function simplify(result) {
  return {
    id: result.id,
    product: result.product,
    productType: result.productType,
    tickers: result.tickers,
    incomeBasis: isBonusEnhance(result) || isTwinwinLike(result) ? "totalReturn" : "coupon",
    terms: {
      strike: pct(result.strike),
      koBarrier: pct(result.ko),
      kiBarrier: pct(result.kiBarrier),
      koStep: result.koStep ? `${(result.koStep * 100).toFixed(0)}% per monthly period` : "None",
      koType: result.koType || "Daily KO",
      couponPa: pct(result.coupon),
      couponBp: `${Math.round(result.coupon * 10000)} bp`,
      couponLabel: result.rateBasis === "period" ? "期間利率" : "p.a.",
      couponBarrier: pct(result.couponBarrier),
      bonusCoupon: pct(result.bonusCoupon),
      bonusRate: pct(result.bonusRate),
      koInterestRate: pct(result.koInterestRate),
      participationRate: pct(result.participationRate),
      tenor: `${result.tenorMonths}M`,
      observationStart: result.observationStartMonths == null ? "None" : `${result.observationStartMonths}M`,
      guaranteedPeriod: result.guaranteedPeriodMonths == null ? "None" : `${result.guaranteedPeriodMonths}M`,
    },
    dataWindow: `${result.sampleStart} to ${result.sampleEnd}`,
    simulatedIssues: result.simulatedIssues,
    historicalPaths: result.simulatedIssues,
    dataQualityWarnings: result.dataQualityWarnings,
    tickerProfiles: result.tickerProfiles,
    koRate: pct(result.koRate),
    assignmentRate: pct(result.assignmentRate, 3),
    monthlyKoDistribution: Object.fromEntries(
      Object.entries(result.monthlyKo)
        .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(([key, value]) => [key, `${value} (${pct(value / result.simulatedIssues)})`]),
    ),
    koMilestones: Object.fromEntries(Object.entries(result.koMilestones).map(([key, value]) => [key, pct(value)])),
    averageHoldingPeriodDays: Number(result.avgHoldingDays.toFixed(1)),
    worstOfDistribution: Object.fromEntries(Object.entries(result.worstOf).map(([key, value]) => [key, pct(value)])),
    totalReturnDistribution: Object.fromEntries(Object.entries(result.totalReturn).map(([key, value]) => [key, pct(value)])),
    winRate: pct(result.winRate),
    lossRate: pct(result.lossRate),
    averageGain: pct(result.avgGain),
    averageLoss: pct(result.avgLoss),
    expectedGain: pct(result.expectedGain),
    expectedLoss: pct(result.expectedLoss),
    expectedAssignmentLoss: pct(result.expectedAssignmentLoss),
    averageCouponReturn: pct(result.avgCouponReturn),
    riskCompensationMultiple: result.riskCompensationMultiple == null ? null : Number(result.riskCompensationMultiple.toFixed(1)),
    returnCompensationMultiple: result.returnCompensationMultiple == null ? null : Number(result.returnCompensationMultiple.toFixed(1)),
    detailedRisk: {
      koMilestones: Object.fromEntries(Object.entries(result.koMilestones).map(([key, value]) => [key, pct(value)])),
      totalReturnTail: {
        p1: pct(result.totalReturn.p1),
        p5: pct(result.totalReturn.p5),
        min: pct(result.totalReturn.min),
      },
      maturityReturnTail: result.maturityReturn ? {
        p1: pct(result.maturityReturn.p1),
        p5: pct(result.maturityReturn.p5),
        min: pct(result.maturityReturn.min),
      } : null,
      ki: result.ki ? {
        barrier: pct(result.ki.barrier),
        touchRate: pct(result.ki.touchRate),
        triggerRate: pct(result.ki.triggerRate),
        lossAfterKiRate: pct(result.ki.lossAfterKiRate),
        fastestTouchDays: Number.isFinite(result.ki.fastestTouchDays) ? `${result.ki.fastestTouchDays} 天` : "-",
        fastestPeakToBarrierDays: Number.isFinite(result.ki.fastestPeakToBarrierDays) ? `${result.ki.fastestPeakToBarrierDays} 天` : "-",
      } : null,
    },
    assignmentReturnDistribution: result.assignmentReturn ? Object.fromEntries(
      Object.entries(result.assignmentReturn).map(([key, value]) => [key, pct(value)]),
    ) : null,
    assignmentRecovery: result.assignmentRecovery ? {
      recoveredRate: pct(result.assignmentRecovery.recoveredRate),
      unrecoveredRate: pct(result.assignmentRecovery.unrecoveredRate),
      averageDays: Number.isFinite(result.assignmentRecovery.averageDays) ? `${result.assignmentRecovery.averageDays.toFixed(1)} 天` : "-",
      medianDays: Number.isFinite(result.assignmentRecovery.medianDays) ? `${result.assignmentRecovery.medianDays.toFixed(1)} 天` : "-",
      p75Days: Number.isFinite(result.assignmentRecovery.p75Days) ? `${result.assignmentRecovery.p75Days.toFixed(1)} 天` : "-",
      maxDays: Number.isFinite(result.assignmentRecovery.maxDays) ? `${result.assignmentRecovery.maxDays} 天` : "-",
    } : null,
    payoffRatio: result.payoffRatio == null ? null : Number(result.payoffRatio.toFixed(2)),
    averageReturn: pct(result.avgReturn),
    averageAnnualizedReturn: pct(result.avgAnnualizedReturn),
    maximumPathDrawdown: pct(result.maximumPathDrawdown),
    stress: result.stress.map((item) => ({
      shock: pct(item.shock, 0),
      finalWorstOf: pct(item.finalWorst),
      return: pct(item.totalReturn),
      assigned: item.assigned,
    })),
    bestIssueTiming: result.bestIssues.map(formatPath),
    worstIssueTiming: result.worstIssues.map(formatPath),
    volRegimes: result.volRegimes ? (() => {
      const fmt = (regime) => regime ? {
        n: regime.n,
        koRate: pct(regime.koRate),
        assignmentRate: pct(regime.assignmentRate, 3),
        cashRate: pct(regime.cashRate),
        avgHoldingDays: Number(regime.avgHoldingDays?.toFixed(0)),
        avgTotalReturn: pct(regime.avgTotalReturn),
        expectedAssignmentLoss: pct(regime.expectedAssignmentLoss),
        dateStart: regime.dateStart,
        dateEnd: regime.dateEnd,
        volMean: pct(regime.volMean),
        volMin: pct(regime.volMin),
        volMax: pct(regime.volMax),
      } : null;
      return {
        p33: pct(result.volRegimes.p33),
        p67: pct(result.volRegimes.p67),
        currentVol: pct(result.volRegimes.currentVol),
        currentBucket: result.volRegimes.currentBucket,
        low:  fmt(result.volRegimes.low),
        mid:  fmt(result.volRegimes.mid),
        high: fmt(result.volRegimes.high),
      };
    })() : null,
  };
}

function formatPath(path) {
  return {
    issueDate: path.issueDate,
    endDate: path.endDate,
    koDate: path.koDate,
    return: pct(path.totalReturn),
    finalWorstOf: pct(path.finalWorst),
    assigned: path.assigned,
  };
}

// ── Monte Carlo GBM Simulation ─────────────────────────────────────────────

function normalRandom() {
  // Box-Muller: standard normal
  let u1;
  do { u1 = Math.random(); } while (u1 === 0);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

export function computeCorrelationMatrix(series, dates, windowDays = 252) {
  const n = series.length;
  if (n === 1) return [[1]];

  const recentDates = dates.slice(-(windowDays + 1));
  // Collect indices where all series have valid prices on consecutive dates
  const validIdxs = [];
  for (let i = 1; i < recentDates.length; i++) {
    const d0 = recentDates[i - 1];
    const d1 = recentDates[i];
    if (series.every(s => {
      const p0 = s.get(d0); const p1 = s.get(d1);
      return Number.isFinite(p0) && p0 > 0 && Number.isFinite(p1) && p1 > 0;
    })) validIdxs.push(i);
  }
  if (validIdxs.length < 10) {
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  }

  const returns = series.map(s =>
    validIdxs.map(i => Math.log(s.get(recentDates[i]) / s.get(recentDates[i - 1]))));
  const len = validIdxs.length;
  const means = returns.map(r => r.reduce((s, v) => s + v, 0) / len);
  const dm = returns.map((r, i) => r.map(v => v - means[i]));

  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else {
        const cov = dm[i].reduce((s, v, k) => s + v * dm[j][k], 0) / len;
        const si = Math.sqrt(dm[i].reduce((s, v) => s + v * v, 0) / len);
        const sj = Math.sqrt(dm[j].reduce((s, v) => s + v * v, 0) / len);
        const corr = (si > 0 && sj > 0) ? Math.max(-1, Math.min(1, cov / (si * sj))) : 0;
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
  }
  return matrix;
}

function cholesky(matrix) {
  // Lower-triangular L such that L × Lᵀ ≈ matrix
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = (i === j) ? (sum > 1e-12 ? Math.sqrt(sum) : 0)
                           : (L[j][j] > 1e-12 ? sum / L[j][j] : 0);
    }
  }
  return L;
}

function applyCholesky(L, n) {
  // Draw n independent N(0,1), return n correlated N(0,1) via L
  const z = [];
  for (let i = 0; i < n; i++) z.push(normalRandom());
  const out = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += L[i][j] * z[j];
    out.push(sum);
  }
  return out;
}

function mcKoReturn(product, endDay) {
  // Compute KO coupon return from simulation day count (no real dates needed)
  const koMonthNum = Math.min(Math.ceil(endDay / 21), Number(product.tenorMonths) || 1);
  const holdingDays = Math.round(endDay * 365 / 252);
  const rate = optionalNumber(product.koInterestRate) ?? (Number(product.coupon) || 0);
  if (rateBasisFor(product) === 'period') return rate;
  if (isTwinwinLike(product)) return rate * (koMonthNum / 12); // integer-month count
  return rate * (holdingDays / 365);
}

export async function runMonteCarlo(product, allSeries, options = {}) {
  const { numPaths = 5000, riskFreeRate = 0.043 } = options;

  const validation = validateBacktestProduct(product);
  if (validation) {
    const error = new Error(`${product.name || product.id}: ${validation}`);
    error.status = 400;
    throw error;
  }

  const series = product.tickers.map(t => allSeries.get(t));
  if (series.some(s => !s?.size)) throw new Error(`${product.name || product.id}: missing price series`);

  const commonDates = [...series[0].keys()].filter(d => series.every(s => s.has(d))).sort();
  if (commonDates.length < 30) throw new Error(`${product.name || product.id}: insufficient history for Monte Carlo`);

  const currentDate = commonDates[commonDates.length - 1];
  const n = product.tickers.length;

  // 126-day realized vol per underlying (≈ 6M, matching FCN implied vol reference tenor)
  const vols = series.map(s => {
    const v = realizedVol126(s, currentDate, commonDates);
    return (v != null && v > 0) ? v : 0.30;
  });

  // Correlation matrix: 252 trading days (≈ 1Y) of log returns
  const corrMatrix = computeCorrelationMatrix(series, commonDates, 252);
  const L = cholesky(corrMatrix);

  const r = riskFreeRate;
  const dt = 1 / 252;
  const totalDays = Math.round(product.tenorMonths * 21);

  // Pre-compute per-underlying GBM coefficients
  const driftCoeff = vols.map(v => (r - 0.5 * v * v) * dt);
  const diffCoeff  = vols.map(v => v * Math.sqrt(dt));

  const obsStartMonth        = productHasKo(product) ? observationStartMonths(product) : product.tenorMonths + 1;
  const guaranteedTradingDays = Math.round((obsStartMonth - 1) * 21);
  const isPeriod             = usesPeriodObservation(product);

  let koCount = 0, assignCount = 0, cashCount = 0;
  const totalReturns   = [];
  const holdingDaysList = [];
  const koMonthCounts  = {};

  for (let p = 0; p < numPaths; p++) {
    const ratios     = new Array(n).fill(1.0); // S_t / S₀ per underlying
    let minWorst     = 1.0;
    let koDay        = null;
    let koMonthNum   = null;
    const memoryHits = new Array(n).fill(false);

    for (let t = 1; t <= totalDays; t++) {
      const z = applyCholesky(L, n);
      for (let i = 0; i < n; i++) {
        ratios[i] *= Math.exp(driftCoeff[i] + diffCoeff[i] * z[i]);
      }

      const worst = Math.min(...ratios);
      if (worst < minWorst) minWorst = worst;

      // KO observation check
      if (t <= guaranteedTradingDays || !productHasKo(product)) continue;
      const isObsDay = isPeriod ? (t % 21 === 0 || t === totalDays) : true;
      if (!isObsDay) continue;

      const monthIdx = Math.ceil(t / 21);
      const koLevel  = koBarrierFor(product, Math.max(0, monthIdx - obsStartMonth));

      if (isMemoryKo(product)) {
        ratios.forEach((ratio, idx) => { if (ratio >= koLevel) memoryHits[idx] = true; });
        if (memoryHits.every(Boolean)) { koDay = t; koMonthNum = monthIdx; break; }
      } else {
        if (worst >= koLevel) { koDay = t; koMonthNum = monthIdx; break; }
      }
    }

    const endDay      = koDay ?? totalDays;
    const finalWorst  = Math.min(...ratios); // ratios at endDay
    const holdingDays = Math.round(endDay * 365 / 252);

    let totalReturn;
    if (koDay != null) {
      totalReturn = mcKoReturn(product, endDay);
      koCount++;
      const mKey = `M${koMonthNum}`;
      koMonthCounts[mKey] = (koMonthCounts[mKey] || 0) + 1;
    } else {
      const couponReturn = annualizedRateReturn(product, holdingDays);
      totalReturn = maturityPayoffReturn(product, { finalWorst, minWorst, couponReturn, holdingDays });
      const assigned = isTwinwinLike(product)
        ? lowerTriggerEvent(product, finalWorst, minWorst)
        : isBonusEnhance(product) ? finalWorst < product.strike
        : fcnDownsideApplies(product, finalWorst, minWorst);
      if (assigned) assignCount++; else cashCount++;
    }
    totalReturns.push(totalReturn);
    holdingDaysList.push(holdingDays);
  }

  return {
    id: product.id,
    product: product.name,
    tickers: product.tickers,
    currentDate,
    numPaths,
    parameters: {
      vols: vols.map((v, i) => ({ ticker: product.tickers[i], vol: pct(v) })),
      correlations: corrMatrix,
      riskFreeRate: pct(r),
      volWindow: '126 個交易日 (≈6M realized)',
      corrWindow: '252 個交易日 (≈1Y historical)',
    },
    koRate:            pct(koCount / numPaths),
    assignmentRate:    pct(assignCount / numPaths, 3),
    cashRate:          pct(cashCount / numPaths),
    avgReturn:         pct(average(totalReturns)),
    expectedAssignmentLoss: pct(
      totalReturns.filter(ret => ret < 0).reduce((s, ret) => s + ret, 0) / numPaths
    ),
    returnDistribution: {
      p1:     pct(percentile(totalReturns, 0.01)),
      p5:     pct(percentile(totalReturns, 0.05)),
      p25:    pct(percentile(totalReturns, 0.25)),
      median: pct(percentile(totalReturns, 0.50)),
      p75:    pct(percentile(totalReturns, 0.75)),
      p95:    pct(percentile(totalReturns, 0.95)),
    },
    monthlyKoDistribution: Object.fromEntries(
      Object.entries(koMonthCounts)
        .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(([key, val]) => [key, `${val} (${pct(val / numPaths)})`])
    ),
    avgHoldingDays: Number((average(holdingDaysList) ?? 0).toFixed(1)),
    stress: stressScenarios(product).map(item => ({
      shock: pct(item.shock, 0), finalWorstOf: pct(item.finalWorst),
      return: pct(item.totalReturn), assigned: item.assigned,
    })),
  };
}

export async function runMonteCarlos(products, options = {}) {
  const invalid = products
    .map(product => ({ product, reason: validateBacktestProduct(product) }))
    .filter(item => item.reason);
  if (invalid.length) {
    const error = new Error(
      `Monte Carlo validation: ${invalid.map(item => `${item.product.name || item.product.id}: ${item.reason}`).join('; ')}`
    );
    error.status = 400;
    throw error;
  }
  const tickers = [...new Set(products.flatMap(p => p.tickers))];
  const allSeries = new Map();
  await Promise.all(tickers.map(async ticker => {
    allSeries.set(ticker, await fetchAdjustedClose(ticker, options));
  }));
  const results = await Promise.all(products.map(p => runMonteCarlo(p, allSeries, options)));
  return {
    generatedAt: new Date().toISOString(),
    method: 'Monte Carlo GBM (Geometric Brownian Motion)',
    numPaths: options.numPaths || 5000,
    riskFreeRate: pct(options.riskFreeRate ?? 0.043),
    notes: [
      '波動度：各標的最近 126 個交易日實現波動率（年化），匹配 FCN 隱含波動率約 6M 期間',
      '相關係數：最近 252 個交易日（≈ 1 年）對數報酬相關矩陣，以 Cholesky 分解生成相關常態亂數',
      `無風險利率：自動從 Yahoo Finance ^IRX 取得（目前：${pct(options.riskFreeRate ?? 0.043)}）`,
      'GBM 路徑：每個交易日一步，drift = (r − σ²/2)dt，diffusion = σ√dt · Z_corr',
      'KO 觸發、保護期、Memory KO、KO Stepdown 邏輯與歷史回測引擎完全一致',
      '模型假設波動度固定（constant vol），不捕捉 volatility clustering 或厚尾分佈',
    ],
    results,
  };
}

export async function runBacktests(products, options = {}) {
  const invalid = products
    .map((product) => ({ product, reason: validateBacktestProduct(product) }))
    .filter((item) => item.reason);
  if (invalid.length) {
    const error = new Error(`Backtest validation failed: ${invalid.map((item) => `${item.product.name || item.product.id}: ${item.reason}`).join("; ")}`);
    error.status = 400;
    throw error;
  }
  const tickers = [...new Set(products.flatMap((product) => product.tickers))];
  const allSeries = new Map();
  await Promise.all(tickers.map(async (ticker) => {
    allSeries.set(ticker, await fetchAdjustedClose(ticker, options));
  }));
  const rawResults = products.map((product) => backtest(product, allSeries));
  const ranked = [...rawResults].sort((a, b) =>
    a.assignmentRate - b.assignmentRate
    || b.avgAnnualizedReturn - a.avgAnnualizedReturn
    || b.koRate - a.koRate
  );
  return {
    generatedAt: new Date().toISOString(),
    source: "Yahoo Finance chart API adjusted close",
    payoffAssumptions: [
      "Every common trading day is treated as a new issue date.",
      "Guaranteed Periods means no KO observation during that many months; KO observation starts from the following month. If it is not supplied, observation starts from month 1.",
      "After the observation start, Daily KO observes every common trading day and Period/Monthly KO observes monthly.",
      "For Memory KO, each underlying becomes a memory underlying once it has individually reached the KO barrier on any KO determination date; KO occurs when all underlyings have become memory underlyings.",
      "For FCN fixed coupon products, coupon is accrued by monthly observation periods; the KO period is prorated by observation days through the KO date.",
      "For WRA / Range Accrual products, coupon is accrued by monthly observation periods and range-eligible observation days after the first observation period.",
      "For BP/BEN / Bonus Enhance products, KO is non-memory period observation only when a KO field exists; KO pays one-time KO interest. If no KO occurs, maturity payoff uses Put Strike for cash/physical settlement, and Bonus Coupon / positive worst-of participation applies only when the bonus / coupon barrier trigger is satisfied.",
      "For Twinwin / Bull Bear products, KO is non-memory and requires all linked underlyings to be at or above KO on the same KO determination date; p.a. KO interest is converted by integer KO months and paid once.",
      "For the reviewed Twinwin / Bull Bear product description, the lower trigger is EKI / final valuation date only. Twinwin / Bull Bear AKI is not backtested until a formal AKI termsheet is reviewed.",
      "For FCN/WRA with AKI or EKI, downside/stock assignment requires both the relevant KI trigger and final worst-of below strike; for NKI/no-KI, final worst-of below strike is enough.",
      "KO Stepdown is applied by monthly observation period only; Daily KO does not step down every trading day.",
      "If a KI barrier is supplied without AKI/EKI wording, backtest is rejected rather than guessing the monitoring style.",
      "Assignment recovery days measure how long the assigned worst-performing underlying historically took after maturity to close back at or above the original strike price; unrecovered paths remain unrecovered through the available data window.",
      "Stress scenarios estimate maturity payoff under parallel final worst-of shocks and do not model interim KO probability.",
    ],
    ranking: ranked.map((result, index) => ({ rank: index + 1, id: result.id, product: result.product })),
    results: rawResults.map(simplify),
  };
}
