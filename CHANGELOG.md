# Changelog

## v2026.07.13.1

- Split mixed-product quote overviews into separate BP/BEN, FCN/WRA, and TWINWIN/Bull Bear pages so unrelated fields are not compressed into one oversized table.
- Removed empty columns within each product-family overview and used shorter display labels without changing the parsed parameters.
- Applied the same grouping to the on-screen preview and generated quote PDF while preserving the existing historical backtest, Monte Carlo, and conclusion features.

## v2026.07.09.2

- **智能結論面板**：歷史回測或蒙地卡羅任一完成後自動顯示 `#conclusionPanel`，列出：
  - 接股風險最低組（綠色驗證卡）+ 理由（MC 接股率 + 歷史接股率 + 期望損失）
  - 歷史期望報酬最佳組（藍色卡）
  - 歷史 vs 蒙地卡羅差異警示（MC 接股率 > 歷史 3× 且 MC > 5%）
  - 當前市場環境警示（所有組 MC 期望報酬為負）
  - 完整排名表格（六欄：MC 接股率 / 歷史接股率 / 歷史平均報酬 / MC 期望報酬 / 接股期望損失）
- **統一 PDF 報告**：「產生完整報告 PDF」按鈕整合結論 + 歷史回測 + 蒙地卡羅為單一可搜尋 PDF（`window.print()`），各節有章節標題分隔，自動補跑缺少的分析。
- 新增 `.pdf-section-header` print CSS 樣式。

## v2026.07.09.1

- Added Monte Carlo GBM simulation as a parallel analysis alongside historical backtest.
- All parameters are auto-fetched/calculated — no manual input required:
  - σ (volatility): 126-day realized vol per underlying (≈ 6M, matching FCN implied vol tenor)
  - ρ (correlation matrix): 252-day historical log-return correlation (Cholesky decomposition)
  - r (risk-free rate): auto-fetched from Yahoo Finance ^IRX (US 13-week T-bill yield)
- New `/api/monte-carlo` endpoint in `fcn-server.mjs`: runs 5,000 GBM paths per product, applies same KO/assignment payoff logic as the historical backtest engine (including guaranteed periods, Memory KO, KO Stepdown, EKI/AKI).
- New `runMonteCarlo` / `runMonteCarlos` exports in `fcn-backtest-core.mjs`.
- New "蒙地卡羅模擬" button in the UI: triggers MC independently of (and in parallel with) historical backtest.
- MC results panel shows per-product: donut outcome chart (KO/cash/assignment), parameter table (vols, correlation matrix), return distribution (P1–P95), KO monthly distribution, and side-by-side comparison with historical backtest if already run.
- Historical backtest is preserved and unchanged.



Version format: `vYYYY.MM.DD.N`, where `N` is the sequential release number for that date.

## v2026.07.03.3

- Added current vol indicator to vol regime display: for each product, computes the most recent 60-day realized vol and labels which bucket (low/mid/high) the current market falls into, shown as highlighted cards above the table with the exact thresholds.
- Added full methodology note below the vol regime table explaining: why 60-day window is used, how P33/P67 percentile buckets are defined, how to read the "current" indicator, and the directional bias correction (high-vol periods overstate assignment risk; low-vol periods understate it).

## v2026.07.03.2

- Added volatility regime stratification to backtest output. For each simulated issue date, the backtest computes the 60-day trailing realized volatility of the worst-of underlying. Paths are divided into low / mid / high volatility thirds using the 33rd and 67th percentiles of the full distribution (self-calibrated from the data). Each regime shows path count, KO rate, assignment rate, cash-to-maturity rate, and average total return. A methodology note explains that fixed-parameter backtests overstate risk in high-vol regimes (real products issued then would have had wider barriers) and understate in low-vol regimes.

## v2026.07.03.1

- Added Stooq.com as automatic fallback data source in `fcn-backtest-core.mjs`: when Yahoo Finance fails (network error, HTTP error, or empty series), the backtest engine retries the same ticker via Stooq CSV API. Yahoo Japan tickers (`*.T`) are converted to Stooq `*.jp` format; US tickers get `.us` suffix. Fallback warning is logged to console.
- Added SVG donut distribution charts to the backtest results panel showing historical KO / cash / assignment breakdown per product (teal = KO, navy = cash, red = assignment).
- Replaced the canvas-image-based backtest PDF export with a browser-native print flow (`window.print()`). The new export produces a fully text-searchable PDF directly from the rendered HTML. Print dialog opens automatically; user selects "Save as PDF" in the browser dialog. No server round-trip required for the backtest PDF.

## v2026.07.02.10

- Re-audited the DBS Bull Bear product description and confirmed the reviewed sample is EKI / final valuation date trigger, not AKI.
- Blocked Twinwin / Bull Bear AKI backtests until a formal AKI termsheet is reviewed, instead of applying an inferred payoff rule.
- Updated on-screen definitions and payoff documentation to separate document-confirmed EKI logic from unverified AKI logic.

## v2026.07.02.9

- Superseded by v2026.07.02.10 after re-auditing the formal Bull Bear product description.
- Corrected Twinwin / Bull Bear AKI payoff: once AKI is touched and no later KO occurs, positive two-way return is lost; recovery to principal is treated as principal return only, so payoff is capped at 0%.
- Kept EKI as final-valuation-date monitoring only.
- Updated on-screen backtest definitions and workflow memory to distinguish AKI path trigger from EKI maturity trigger.

## v2026.07.02.8

- Fixed TWINWIN/Bull Bear quote parsing so `KO`, `KO參數`, and `KO Parameter` are treated as `KO Barrier` instead of being dropped as unknown fields.
- Added `AutoCall Frequency` as a preserved quote condition field for TWINWIN-style header tables.
- Confirmed the backtest engine continues to treat Twinwin / Bull Bear KO as non-memory: all linked underlyings must satisfy KO on the same observation date.

## v2026.07.02.7

- Added a dedicated `產生回測 PDF` export for backtest conclusions.
- Backtest PDF includes conclusion summary, main risk table, funding/return reference, detailed risk table, and field definitions.
- Reused the existing PDF file generation flow so backtest output can be opened and shared like the quote PDF.

## v2026.07.02.6

- Rewrote BP/BEN maturity payoff as an explicit three-step algorithm: Put Strike settlement, Coupon Barrier bonus eligibility, then Bonus Coupon versus participation upside.
- Added a BP payoff detail helper so no-KO BP paths are visibly total-return payoff paths, not coupon/interest paths.
- Added BP payoff checks for downside, cash/no-bonus, bonus-floor, and upside-participation cases.

## v2026.07.02.5

- Changed BP/BEN backtest display to use total return as the income lens instead of interest/coupon.
- Renamed the main backtest income column to `收益條件` and the risk column to `收益/風險`.
- Kept `平均實收利息` visible as a factual 0%/KO-interest field for BP/BEN, but marked it as not the core income metric.

## v2026.07.02.4

- Added no-header BP/BEN quote parsing for the confirmed DBS desk column order: product, currency, BBG codes, tenor, put strike, coupon barrier, participation rate, and flat bonus coupon.
- Treated `BP` as a Bonus Performance / Bonus Enhance product throughout parser and backtest validation, so BP without KO can enter backtest.
- Stopped applying the FCN default `Guaranteed Periods = 1m` to BP quote rows.

## v2026.07.02.3

- Fixed PDF quote summary condition tables so row heights stay consistent.
- Hid the `KO 價` price column entirely when the quote has no KO barrier, matching the existing no-KI / no lower-trigger display rule.

## v2026.07.02.2

- Corrected Regular BEN / BP quote parsing to preserve the actual quote columns: `Put Strike (%)`, `Coupon Barrier (%)`, `PR (%)`, and `Bonus Coupon (%, flat)`.
- Stopped parsing `Coupon Barrier` as coupon income and stopped renaming `Bonus Coupon` into guessed KO/coupon fields.
- Updated BEN/BP maturity backtest logic so `Coupon Barrier` controls bonus eligibility after `Put Strike` cash-settlement protection is met.

## v2026.07.02.1

- Corrected KO Stepdown backtest logic so stepdown is applied by monthly observation period only.
- Daily KO with `KO Step` no longer decreases the KO barrier every trading day; each trading day uses the KO level for its current monthly observation period.
- Updated backtest assumption text and field definitions to make the monthly-only Stepdown rule explicit.

## v2026.07.01.9

- Re-audited DBS FCN/WRA no-KI, BP/BEN, and Bull Bear/Twinwin payoff definitions against the provided product descriptions.
- Corrected BEN/BP KO handling to non-memory period observation, matching the BP with KO product description.
- Changed FCN/WRA coupon accrual from simple holding-day prorating to monthly observation-period accrual, with KO-period prorating and WRA range-day counting.
- Added AKI/EKI validation: if a KI barrier is supplied but AKI/EKI is not stated, backtest is rejected instead of guessing.
- Stopped treating `MKO` / `DKO` as Memory by acronym alone; Memory KO now requires explicit `Memory` wording.
- Split BEN/BP `Bonus Rate`, `KO Interest Rate`, `Rate Basis`, `Range Lower`, and `Range Upper` parsing so period rates and p.a. rates are not mixed silently.
- Updated backtest definitions to describe KI trigger timing and BP/BEN/Twinwin income sources more precisely.

## v2026.07.01.8

- Corrected Twinwin / Bull Bear KO logic to be non-memory and same-date all-underlying KO.
- Corrected Twinwin / Bull Bear p.a. KO interest conversion to use integer KO months instead of daily holding days.
- Updated field definitions and payoff assumptions to clarify Twinwin KO behavior.

## v2026.07.01.7

- Added `回執行價` recovery statistics for assignment / physical settlement paths.
- Recovery days are measured from maturity to the first later historical close where the assigned worst-performing underlying reaches the original strike price.
- Added recovered / unrecovered metrics to detailed risk output and field definitions.
- Added API payoff assumption text clarifying that recovery days are historical observations, not predictions.

## v2026.07.01.6

- Added `Participation Rate` parsing and backtest support for BEN / BP maturity extra return.
- Clarified Twinwin KO interest accumulation: p.a. quote rates are accrued by actual holding days to the KO date; already-converted applicable auto-call rates should be used directly when supplied.
- Documented that BP/BEN defaults to 100% participation only when no participation rate is visible.

## v2026.07.01.5

- Superseded by v2026.07.02.10 for Twinwin / Bull Bear AKI support wording.
- Clarified BEN / BP and Twinwin payoff income sources in the backtest field definitions.
- Added explicit Twinwin AKI wording: a path that touches lower trigger and never KOs loses the two-way positive payoff and goes to physical/downside payoff; a later KO still pays the one-time KO interest.
- Clarified BP maturity extra return calculation and the difference between annualized quote rates and already-converted period rates.

## v2026.07.01.4

- Superseded by v2026.07.02.10 for Twinwin / Bull Bear AKI support wording.
- Added backtest payoff support for BEN / Bonus Enhance using one-time KO interest and maturity cash-or-physical payoff.
- Added backtest payoff support for Twinwin / Bull Bear using one-time KO interest, EKI/AKI lower-trigger handling, and two-way no-trigger payoff.
- Added parser support for `Conditional Coupon` and passed `Barrier Type` into backtest validation.
- Updated backtest labels and definitions to use `接股/實物` wording across FCN, BEN, and Twinwin-style products.
- Added `平均總報酬` to the second backtest table so BEN maturity extra return and Twinwin two-way payoff are visible outside the main risk table.
- Expanded API payoff assumptions to disclose BEN and Twinwin modeling rules.

## v2026.07.01.3

- Audited backtest payoff support against reviewed DBS termsheet definitions.
- Added explicit guards so BEN / Bonus Enhance, Bull Bear / Twinwin, and Superbull are not backtested with the FCN / WRA payoff model before their dedicated payoff logic is implemented.
- Kept the funding-efficiency second table available for supported FCN / WRA backtests.

## v2026.07.01.2

- Moved `平均資金天數` and `平均實收利息` out of the main backtest risk table into a separate funding-efficiency reference table.
- Renamed main backtest headers to clarify ticket coupon, assignment P/L, and interest coverage.
- Added bullet definitions below the backtest tables for every displayed risk and funding-efficiency field.

## v2026.07.01.1

- Added 1.5-year and 5-year chart periods.
- Added optional RSI indicator.
- Updated chart data fetch and cache keys to support 5-year historical data.
- Improved PDF overview table word wrapping.
- Standardized daily quote rules for omitted `Guaranteed Periods` and NONE/NKI KI handling.
- Added structured project docs, product type standards, and DBS payoff definition references.
