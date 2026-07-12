import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { isBonusEnhance, optionalNumber, runBacktests, runMonteCarlos, validateBacktestProduct } from "./fcn-backtest-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportsDir = path.join(__dirname, "outputs", "reports");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const authPin = process.env.FCN_PIN || "";
const authEnabled = Boolean(authPin);
const sessionCookie = "fcn_session";
const sessionToken = crypto.randomBytes(32).toString("hex");
const chartCache = new Map();
const chartCacheTtlMs = 18 * 60 * 60 * 1000;
const maxBacktestProducts = 60;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

function localNetworkUrls() {
  const urls = [`http://127.0.0.1:${port}/fcn-pricing-tool.html`];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}/fcn-pricing-tool.html`);
      }
    }
  }
  return urls;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function requestBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (process.env.RENDER ? "https" : "http");
  return `${proto}://${req.headers.host || `127.0.0.1:${port}`}`;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");
      return index >= 0 ? [part.slice(0, index), decodeURIComponent(part.slice(index + 1))] : [part, ""];
    }));
}

function isAuthed(req) {
  if (!authEnabled) return true;
  return parseCookies(req)[sessionCookie] === sessionToken;
}

function redirect(res, location) {
  res.writeHead(302, {
    "Location": location,
    "Cache-Control": "no-store",
  });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function dataUrlBytes(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/(?:jpeg|jpg|png));base64,([\s\S]+)$/i);
  if (!match) throw new Error("Invalid report page image");
  return {
    mime: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64"),
  };
}

function normalizedKoType(value) {
  const compact = String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!compact) return "";
  const hasMemory  = compact.includes("MEMORY");
  const hasDaily   = compact.includes("DAILY") || compact.includes("DKO");
  const hasMonthly = compact.includes("MONTH") || compact.includes("PERIOD") || compact.includes("MKO") || compact.includes("END");
  if (hasDaily)   return hasMemory ? "Daily Memory" : "Daily KO";
  if (hasMonthly) return hasMemory ? "Period End Memory" : "Monthly KO";
  if (hasMemory)  return "Period End Memory"; // bare "Memory" defaults to monthly memory
  return compact;
}

function positiveNumber(value) {
  const number = optionalNumber(value);
  return number != null && number > 0 ? number : null;
}

async function buildPdfFromImages(images) {
  if (!Array.isArray(images) || !images.length) {
    const error = new Error("Missing report pages");
    error.status = 400;
    throw error;
  }
  if (images.length > 20) {
    const error = new Error("Too many report pages");
    error.status = 400;
    throw error;
  }

  const pdfDoc = await PDFDocument.create();
  const pageSize = [595.28, 841.89]; // A4 portrait in points
  for (const image of images) {
    const { mime, bytes } = dataUrlBytes(image);
    const embedded = mime.includes("png")
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);
    const page = pdfDoc.addPage(pageSize);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageSize[0],
      height: pageSize[1],
    });
  }

  return Buffer.from(await pdfDoc.save());
}

async function savePdfReport(images) {
  const pdf = await buildPdfFromImages(images);
  await fs.mkdir(reportsDir, { recursive: true });
  const filename = `fcn-report-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.pdf`;
  await fs.writeFile(path.join(reportsDir, filename), pdf);
  return filename;
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FCN 工具登入</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, "Noto Sans TC", sans-serif; background: #f5f7fb; color: #172033; }
    form { width: min(360px, calc(100vw - 32px)); background: #fff; border: 1px solid #d9deea; border-radius: 8px; padding: 22px; }
    h1 { margin: 0 0 16px; font-size: 22px; }
    label { display: block; margin-bottom: 6px; color: #5c667a; font-weight: 700; font-size: 13px; }
    input, button { width: 100%; box-sizing: border-box; border-radius: 6px; padding: 11px 12px; font: inherit; }
    input { border: 1px solid #d9deea; }
    button { margin-top: 12px; border: 1px solid #1d3557; background: #1d3557; color: white; font-weight: 700; }
    p { margin: 10px 0 0; color: #b91c1c; font-size: 13px; }
  </style>
</head>
<body>
  <form method="post" action="/api/login">
    <h1>FCN 詢價圖表</h1>
    <label for="pin">PIN</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus />
    <button type="submit">登入</button>
    ${error ? `<p>${error}</p>` : ""}
  </form>
</body>
</html>`;
}

async function fetchYahooRemote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const hosts = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
  let lastError;

  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encoded}?range=5y&interval=1d&events=history`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(12000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${host} HTTP ${response.status}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
      if (!text.trim().startsWith("{")) throw new Error(`${host} returned non-JSON: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
      const parsed = JSON.parse(text);
      if (parsed.chart?.error) throw new Error(`${host} ${parsed.chart.error.description || "chart error"}`);
      return text;
    } catch (error) {
      console.error(`${host} failed for ${symbol}: ${error.message}`);
      lastError = error;
    }
  }

  try {
    return await fetchYahooSpark(symbol);
  } catch (error) {
    console.error(`spark failed for ${symbol}: ${error.message}`);
    throw lastError || error || new Error("Yahoo Finance request failed");
  }
}

async function fetchYahoo(symbol) {
  const key = String(symbol).trim().toUpperCase();
  const cached = chartCache.get(key);
  const now = Date.now();
  if (cached?.body && now - cached.savedAt < chartCacheTtlMs) {
    return cached.body;
  }
  if (cached?.promise) {
    return await cached.promise;
  }

  const promise = fetchYahooRemote(symbol);
  chartCache.set(key, { ...cached, promise });
  try {
    const body = await promise;
    chartCache.set(key, { body, savedAt: Date.now() });
    return body;
  } catch (error) {
    chartCache.delete(key);
    throw error;
  }
}

async function fetchYahooSpark(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encoded}&range=5y&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`spark HTTP ${response.status}: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
  const parsed = JSON.parse(text);
  const sparkResponse = parsed.spark?.result?.[0]?.response?.[0];
  if (!sparkResponse?.timestamp?.length) throw new Error("spark returned no price history");
  return JSON.stringify({
    chart: {
      result: [{
        meta: sparkResponse.meta,
        timestamp: sparkResponse.timestamp,
        indicators: sparkResponse.indicators,
      }],
      error: null,
    },
  });
}

async function fetchRiskFreeRate() {
  // Fetch latest US 13-week T-bill yield from Yahoo Finance ^IRX (in % → decimal)
  try {
    const text = await fetchYahooRemote('^IRX');
    const parsed = JSON.parse(text);
    const closes = parsed.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const latest = [...closes].reverse().find(v => Number.isFinite(v));
    if (Number.isFinite(latest) && latest > 0) return latest / 100;
  } catch (err) {
    console.warn(`[monte-carlo] Could not fetch ^IRX: ${err.message}`);
  }
  return 0.043; // fallback ≈ current US T-bill
}

// Convert Groq "Key: Value" block output → header-table format the frontend parser handles
function convertKeyValueToTabFormat(text) {
  // Parse all blocks into field maps
  const blocks = text.trim().split(/\n\s*\n/).filter(b => b.trim());
  const allFields = blocks.map(block => {
    const raw = {};
    block.split(/\n/).forEach(line => {
      const colonM = line.match(/^([A-Za-z一-鿿㐀-䶿][^:\n]{0,50}):\s*(.+)$/);
      if (colonM) { raw[colonM[1].trim().toLowerCase()] = colonM[2].trim(); }
    });
    if (!Object.keys(raw).length) return {};

    // Normalise field names using canonical aliases
    const get = (...names) => {
      for (const n of names) {
        const v = raw[n.toLowerCase()];
        if (v !== undefined) return v;
      }
      return undefined;
    };

    return {
      "組合":    get("組合", "no", "combo", "product no", "product number"),
      "Product": get("product", "product type", "type"),
      "Currency":get("currency", "ccy", "幣別"),
      "BBG Code 1": get("bbg code 1", "bbg 1", "bbg code1", "underlying 1", "stock 1", "ticker 1", "code 1"),
      "BBG Code 2": get("bbg code 2", "bbg 2", "bbg code2", "underlying 2", "stock 2", "ticker 2", "code 2"),
      "BBG Code 3": get("bbg code 3", "bbg 3", "bbg code3", "underlying 3", "stock 3", "ticker 3", "code 3"),
      "Tenor":   get("tenor", "term", "maturity", "期限"),
      "Strike":  get("strike", "strike price", "strike (%)", "execution price", "執行價"),
      "KO Barrier": get("ko barrier", "ko level", "ko (%)", "ko price", "ko barrier (%)",
                        "autocall barrier", "auto call barrier", "autocall level", "auto call level",
                        "autocall trigger", "auto call trigger", "autocall price",
                        "knockout barrier", "knock out barrier", "call level",
                        "ko參數", "ko parameter", "敲出價"),
      "Coupon":  get("coupon", "coupon p.a.", "coupon rate", "coupon (p.a.)", "年化收益", "票面利率"),
      "KI Barrier": get("ki barrier", "ki level", "ki (%)", "ki barrier (%)",
                        "knock-in barrier", "knock in barrier", "knockin barrier",
                        "downside barrier", "protection barrier", "下限觸發價"),
      "Memory KO":  get("memory ko", "memory", "memory autocall"),
      "KO Frequency": get("ko frequency", "autocall frequency", "observation frequency", "頻率"),
      "Guaranteed Periods": get("guaranteed periods", "non-call period", "non call period",
                                "guarantee period", "lock-in period", "起觀月份"),
      "Barrier Type": get("barrier type", "ki type", "knock-in type", "knockin type",
                          "barrier monitoring", "observation type"),
      "Put Strike": get("put strike", "put strike (%)", "put level", "put price"),
      "Coupon Barrier": get("coupon barrier", "coupon trigger", "income barrier"),
      "PR":      get("pr", "participation rate", "participation", "pr (%)"),
      "Bonus Coupon": get("bonus coupon", "bonus coupon (%, flat)", "bonus", "flat coupon"),
    };
  }).filter(f => Object.keys(f).some(k => f[k] !== undefined));

  if (!allFields.length) return text; // passthrough if nothing parsed

  const hasBP = allFields.some(f => /^(BP|BEN|Regular BEN)/i.test(f["Product"] || ""));

  if (hasBP) {
    // BP/BEN table format
    const header = "Product | Currency | BBG Code 1 | BBG Code 2 | BBG Code 3 | Tenor (m) | Put Strike (%) | Coupon Barrier (%) | PR (%) | Bonus Coupon (%, flat)";
    const rows = allFields.map(f => {
      const tenorNum = (f["Tenor"] || "6m").replace(/m$/i, "");
      return [
        f["Product"] || "BP",
        f["Currency"] || "USD",
        f["BBG Code 1"] || "",
        f["BBG Code 2"] || "",
        f["BBG Code 3"] || "",
        tenorNum,
        f["Put Strike"] || "",
        f["Coupon Barrier"] || "",
        f["PR"] || "",
        f["Bonus Coupon"] || "",
      ].join(" | ");
    });
    return header + "\n" + rows.join("\n");
  } else {
    // FCN table: NO | Product | Currency | BBG Code 1 | BBG Code 2 | BBG Code 3 | Tenor | Strike | KO Barrier | Coupon | KI Barrier | Barrier Type | Memory KO | KO Frequency | Guaranteed Periods
    const header = "NO | Product | Currency | BBG Code 1 | BBG Code 2 | BBG Code 3 | Tenor | Strike | KO Barrier | Coupon | KI Barrier | Barrier Type | Memory KO | KO Frequency | Guaranteed Periods";
    const rows = allFields.map((f, i) => {
      const no = (f["組合"] || f["No"] || String.fromCharCode(65 + i)).replace(/^組合\s*/i, "").trim();
      const tenor = f["Tenor"] || "6m";
      const kiBarrier = f["KI Barrier"] || "NONE";
      const kiPresent = !/^(none|nki|n\/a|-)$/i.test(kiBarrier.trim());
      // Default Barrier Type to EKI when KI is present (European KI = checked at maturity only)
      const barrierType = f["Barrier Type"] || (kiPresent ? "EKI" : "");
      return [
        no,
        f["Product"] || "Regular FCN",
        f["Currency"] || "USD",
        f["BBG Code 1"] || "",
        f["BBG Code 2"] || "",
        f["BBG Code 3"] || "",
        tenor,
        f["Strike"] || "",
        f["KO Barrier"] || "NONE",
        f["Coupon"] || "",
        kiBarrier,
        barrierType,
        f["Memory KO"] || "No",
        f["KO Frequency"] || "Monthly",
        f["Guaranteed Periods"] || "",
      ].join(" | ");
    });
    return header + "\n" + rows.join("\n");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }

    if (url.pathname === "/health") {
      return send(res, 200, "ok", { "Content-Type": "text/plain;charset=utf-8" });
    }

    if (url.pathname === "/login") {
      if (isAuthed(req)) return redirect(res, "/fcn-pricing-tool.html");
      return send(res, 200, loginPage(url.searchParams.has("error") ? "PIN 錯誤，請再試一次。" : ""), { "Content-Type": "text/html;charset=utf-8" });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      if (params.get("pin") === authPin) {
        res.writeHead(302, {
          "Location": "/fcn-pricing-tool.html",
          "Set-Cookie": `${sessionCookie}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
          "Cache-Control": "no-store",
        });
        return res.end();
      }
      return redirect(res, "/login?error=1");
    }

    if (!isAuthed(req)) {
      if (url.pathname.startsWith("/api/")) {
        return send(res, 401, JSON.stringify({ error: "Unauthorized" }), { "Content-Type": "application/json;charset=utf-8" });
      }
      return redirect(res, "/login");
    }

    if (url.pathname === "/api/chart") {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) {
        return redirect(res, "/fcn-pricing-tool.html");
      }
      const body = await fetchYahoo(symbol);
      return send(res, 200, body, { "Content-Type": "application/json;charset=utf-8" });
    }

    if (url.pathname === "/api/backtest" && req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      if (!Array.isArray(payload.products) || !payload.products.length) {
        return send(res, 400, JSON.stringify({ error: "Missing products" }), { "Content-Type": "application/json;charset=utf-8" });
      }
      if (payload.products.length > maxBacktestProducts) {
        return send(res, 400, JSON.stringify({ error: `一次最多回測 ${maxBacktestProducts} 組報價` }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const products = payload.products.map((product, index) => ({
        id: String(product.id || product.no || `Q${index + 1}`),
        name: String(product.name || product.id || product.no || `Quote ${index + 1}`),
        productType: String(product.productType || product.product || ""),
        tickers: (Array.isArray(product.tickers) ? product.tickers : [])
          .map((ticker) => String(ticker || "").trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 3),
        strike: Number(product.strike),
        ko: positiveNumber(product.ko),
        kiBarrier: optionalNumber(product.kiBarrier),
        koStep: Number(product.koStep) || 0,
        koType: normalizedKoType(product.koType),
        barrierType: String(product.barrierType || product.kiType || ""),
        coupon: optionalNumber(product.coupon) ?? 0,
        couponBarrier: optionalNumber(product.couponBarrier),
        bonusCoupon: optionalNumber(product.bonusCoupon),
        bonusRate: optionalNumber(product.bonusRate),
        koInterestRate: optionalNumber(product.koInterestRate),
        participationRate: optionalNumber(product.participationRate),
        rangeLower: optionalNumber(product.rangeLower),
        rangeUpper: optionalNumber(product.rangeUpper),
        rateBasis: String(product.rateBasis || ""),
        tenorMonths: Number(product.tenorMonths),
        guaranteedPeriodMonths: Number.isFinite(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths))
          ? Math.max(0, Math.floor(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths)))
          : null,
        observationStartMonths: Number(product.observationStartMonths) || undefined,
      })).filter((product) =>
        product.tickers.length
        && Number.isFinite(product.strike)
        && product.strike > 0
        && ((Number.isFinite(product.ko) && product.ko > 0) || isBonusEnhance(product))
        && Number.isFinite(product.tenorMonths)
        && product.tenorMonths > 0
      );
      if (!products.length) {
        return send(res, 400, JSON.stringify({ error: "No valid backtest products" }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const invalid = products
        .map((product) => ({ product, reason: validateBacktestProduct(product) }))
        .filter((item) => item.reason);
      if (invalid.length) {
        return send(res, 400, JSON.stringify({
          error: `回測參數不完整或尚未支援：${invalid.map((item) => `${item.product.name}: ${item.reason}`).join("；")}`,
        }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const result = await runBacktests(products, { startYear: Number(payload.startYear) || 2010 });
      return send(res, 200, JSON.stringify(result), { "Content-Type": "application/json;charset=utf-8" });
    }

    if (url.pathname === "/api/monte-carlo" && req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      if (!Array.isArray(payload.products) || !payload.products.length) {
        return send(res, 400, JSON.stringify({ error: "Missing products" }), { "Content-Type": "application/json;charset=utf-8" });
      }
      if (payload.products.length > maxBacktestProducts) {
        return send(res, 400, JSON.stringify({ error: `一次最多 ${maxBacktestProducts} 組` }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const products = payload.products.map((product, index) => ({
        id: String(product.id || product.no || `Q${index + 1}`),
        name: String(product.name || product.id || product.no || `Quote ${index + 1}`),
        productType: String(product.productType || product.product || ""),
        tickers: (Array.isArray(product.tickers) ? product.tickers : [])
          .map((ticker) => String(ticker || "").trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 3),
        strike: Number(product.strike),
        ko: positiveNumber(product.ko),
        kiBarrier: optionalNumber(product.kiBarrier),
        koStep: Number(product.koStep) || 0,
        koType: normalizedKoType(product.koType),
        barrierType: String(product.barrierType || product.kiType || ""),
        coupon: optionalNumber(product.coupon) ?? 0,
        couponBarrier: optionalNumber(product.couponBarrier),
        bonusCoupon: optionalNumber(product.bonusCoupon),
        bonusRate: optionalNumber(product.bonusRate),
        koInterestRate: optionalNumber(product.koInterestRate),
        participationRate: optionalNumber(product.participationRate),
        rangeLower: optionalNumber(product.rangeLower),
        rangeUpper: optionalNumber(product.rangeUpper),
        rateBasis: String(product.rateBasis || ""),
        tenorMonths: Number(product.tenorMonths),
        guaranteedPeriodMonths: Number.isFinite(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths))
          ? Math.max(0, Math.floor(Number(product.guaranteedPeriodMonths ?? product.guaranteedMonths)))
          : null,
        observationStartMonths: Number(product.observationStartMonths) || undefined,
      })).filter((product) =>
        product.tickers.length
        && Number.isFinite(product.strike) && product.strike > 0
        && ((Number.isFinite(product.ko) && product.ko > 0) || isBonusEnhance(product))
        && Number.isFinite(product.tenorMonths) && product.tenorMonths > 0
      );
      if (!products.length) {
        return send(res, 400, JSON.stringify({ error: "No valid products for Monte Carlo" }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const invalid = products
        .map((product) => ({ product, reason: validateBacktestProduct(product) }))
        .filter((item) => item.reason);
      if (invalid.length) {
        return send(res, 400, JSON.stringify({
          error: `參數不完整：${invalid.map((item) => `${item.product.name}: ${item.reason}`).join("；")}`,
        }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const riskFreeRate = await fetchRiskFreeRate();
      const numPaths = Math.min(Number(payload.numPaths) || 5000, 20000);
      const result = await runMonteCarlos(products, {
        startYear: Number(payload.startYear) || 2010,
        riskFreeRate,
        numPaths,
      });
      return send(res, 200, JSON.stringify(result), { "Content-Type": "application/json;charset=utf-8" });
    }

    if (url.pathname === "/api/pdf" && req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const pdf = await buildPdfFromImages(payload.images);
      const filename = `fcn-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      return send(res, 200, pdf, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
    }

    if (url.pathname === "/api/pdf-file" && req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const filename = await savePdfReport(payload.images);
      return send(res, 200, JSON.stringify({
        url: `/reports/${filename}`,
        openUrl: `${requestBaseUrl(req)}/reports/${filename}`,
        downloadUrl: `${requestBaseUrl(req)}/reports/${filename}?download=1`,
      }), { "Content-Type": "application/json;charset=utf-8" });
    }

    if (url.pathname.startsWith("/reports/")) {
      const filename = path.basename(decodeURIComponent(url.pathname.slice("/reports/".length)));
      if (!filename.endsWith(".pdf")) {
        return send(res, 404, "Not found", { "Content-Type": "text/plain;charset=utf-8" });
      }
      const pdf = await fs.readFile(path.join(reportsDir, filename));
      const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      return send(res, 200, pdf, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${filename}"`,
      });
    }

    if (url.pathname === "/api/parse-quote-image" && req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const { image, mimeType = "image/jpeg" } = payload;
      if (!image) return send(res, 400, JSON.stringify({ error: "Missing image data" }), { "Content-Type": "application/json;charset=utf-8" });
      if (!GROQ_API_KEY) return send(res, 500, JSON.stringify({ error: "Groq API key not configured" }), { "Content-Type": "application/json;charset=utf-8" });

      const prompt = `You are a financial structured product quote reader. Extract ALL FCN/BP/BEN/Twinwin product quotes from this image.

Output each quote in EXACTLY this format (use a colon+space between field name and value, one field per line, blank line between quotes):

組合: A
Product: Regular FCN
Currency: USD
BBG Code 1: NVDA UW
BBG Code 2: MU UW
BBG Code 3: AVGO UW
Tenor: 6m
Strike: 100%
KI Barrier: 60%
Barrier Type: EKI
KO Barrier: 103%
Coupon: 8.5% p.a.
Guaranteed Periods: 1m
Memory KO: No
KO Frequency: Monthly

Rules:
- 組合 label must be a single letter (A, B, C...) or short number
- Only output fields that are visible in the image
- KI Barrier: use NONE if no KI
- Barrier Type: always output EKI for regular FCN (European KI, checked at maturity only); output AKI only if image explicitly shows American/continuous KI
- KO Barrier: use NONE if no KO
- For BP/BEN use: Put Strike, Coupon Barrier, Participation Rate, Bonus Coupon instead of Strike/KI/KO/Coupon
- Output ONLY the structured text, no explanations, no markdown`;

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${image}` } },
            ],
          }],
          temperature: 0.1,
          max_tokens: 3000,
        }),
      });
      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return send(res, 502, JSON.stringify({ error: `Groq API error: ${groqRes.status} ${errText.slice(0,200)}` }), { "Content-Type": "application/json;charset=utf-8" });
      }
      const groqData = await groqRes.json();
      const rawText = groqData?.choices?.[0]?.message?.content || "";
      // Convert "Key: Value" blocks → tab-separated lines the parser understands
      const quoteText = convertKeyValueToTabFormat(rawText);
      return send(res, 200, JSON.stringify({ quoteText, raw: rawText }), { "Content-Type": "application/json;charset=utf-8" });
    }

    if (url.pathname === "/" || url.pathname === "/fcn-pricing-tool.html") {
      const html = await fs.readFile(path.join(__dirname, "fcn-pricing-tool.html"), "utf8");
      return send(res, 200, html, { "Content-Type": "text/html;charset=utf-8" });
    }

    return send(res, 404, "Not found", { "Content-Type": "text/plain;charset=utf-8" });
  } catch (error) {
    return send(res, error.status || 500, JSON.stringify({ error: error.message }), { "Content-Type": "application/json;charset=utf-8" });
  }
});

server.listen(port, host, () => {
  console.log("FCN tool running:");
  for (const url of localNetworkUrls()) console.log(`  ${url}`);
  console.log(authEnabled ? "PIN protection enabled." : "PIN protection disabled. Set FCN_PIN before public deployment.");
});
