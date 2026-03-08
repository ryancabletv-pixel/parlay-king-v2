# Parlay King — Session Progress Notes
**Date:** March 8, 2026 (1AM+ session)
**Status:** PAUSED — ready to resume

---

## ✅ COMPLETED THIS SESSION

### Phase 1 — Startup Catch-Up Logic (DONE)
- `scheduler.ts` updated with startup catch-up: on boot, checks if today's picks exist; if not, triggers `generateDailyPicks()` automatically
- Imports `getPicksByDate` from storage to check for existing picks

### Phase 2 — Tiered Pick System (DONE)
**`goldStandardV2.ts`:**
- Lowered `MINIMUM` threshold from 68% → **64%** so Free tier picks (64-67%) are no longer discarded
- Updated `CONFIDENCE_THRESHOLDS`:
  - `FREE_TIER: 64` (64-67% — dashboard only)
  - `VIP_TIER: 68` (68-69% — Pro tier minimum, shown on main site)
  - `PRO_TIER: 70` (70%+ — Lifetime tier minimum)
  - `POWER_PICK: 80` (unchanged)

**`routes.ts`:**
- Added **Free picks save loop** after MLS legs save — saves 64-67% picks with `tier='free'` to DB, skipping duplicates
- Updated total count to include `freeCount`
- Updated `/picks.json` endpoint: added `publicActive` filter (confidence >= 68 AND tier !== 'free') so Free tier picks are hidden from main site
- Updated `/api/picks/today` endpoint: same `publicActive` filter applied
- Updated `featured_games` in picks.json to use `publicActive` instead of `active`

### Phase 3 — MLS Sport Detection Fix (DONE)
**`apiFootball.ts`:**
- Added MLS team name keyword detection as fallback
- If `leagueId === 253`, sport is forced to `'mls'`
- If team names match any of 30+ known MLS club names, sport is overridden to `'mls'`
- Logs a message when MLS team name detection fires

---

## 🔲 REMAINING WORK

### Phase 4 — V3 Validator Tab in Admin Panel
**What needs to be done:**
- Add a new "V3 Validator" nav item to `admin.html` sidebar
- Add a new `page-validator` div with a full fixture input form (all 12 factors)
- Add `/api/admin/v2-validate` POST endpoint to `routes.ts` (currently missing — the admin.html calls it but it doesn't exist!)
- The endpoint should call `runTitanXII(fixture)` and return the full result
- Display all 12 factor scores in the result panel

### Phase 5 — Build & Deploy to Railway
- Run `npm run build` in `/home/ubuntu/parlay-king`
- Push to Railway via `railway up` or git push
- Verify picks are generating correctly
- Verify Free tier picks appear in admin but NOT on main site

---

## KEY FILE LOCATIONS
- `/home/ubuntu/parlay-king/server/routes.ts` — main routes (1229 lines)
- `/home/ubuntu/parlay-king/server/goldStandardV2.ts` — prediction engine
- `/home/ubuntu/parlay-king/server/apis/apiFootball.ts` — API fetcher (666 lines)
- `/home/ubuntu/parlay-king/server/scheduler.ts` — cron scheduler
- `/home/ubuntu/parlay-king/server/templates/admin.html` — admin panel

## CRITICAL NOTE
The `/api/admin/v2-validate` endpoint is called by `admin.html` but **does not exist** in `routes.ts`.
This is why the validator in the Engine tab fails. Must add this endpoint in Phase 4.
