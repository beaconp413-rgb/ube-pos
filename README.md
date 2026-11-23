# Ube POS — Ilocos branch team POS

Offline PWA (plain HTML/CSS/JS, no build). Data in localStorage key `ube-pos-v1`; the current seller name is per phone in `ube-pos-me`.
Built 2026-11-23 from the WYF Christmas orientation rules (Nov 21, 2026).

| Rule from orientation | Where in the app |
|---|---|
| First in, first out; date received on day one; 3 months frozen | Stock: dated batches, sold oldest first, expiry auto = received + 90 days, expiry alerts |
| Thawed >24 hrs → discard; tasting/giveaways | Stock → ⋯ → Remove (logged as loss, counted in real profit) |
| Payment first, ≥50% down on bulk/reseller | Orders: deposit warning, payments, release deducts stock |
| Cutoff Wed 12 noon, order once a week | Home: cutoff countdown + suggested order (14-day sell rate + open orders − stock) |
| Real profit, revolving fund, daily cash in/out | Money + Reports (sales − franchise cost − expenses − losses) |
| Christmas target | Home progress bar + pcs/day needed |
| Thank-you, feedback, next product | Receipt message (editable in Settings), share to Messenger |
| Resellers, corporate, church | Customer types + reseller price per product |

Files: index.html, app.js, styles.css, manifest.json, sw.js, icons/.
Test: scratchpad test_ube.py (Playwright, server on 127.0.0.1:8790) — 19/19 passed.
Phase 2: shared cloud sync (Supabase) so every team phone sees the same stock.

## v1.1 (2026-11-23) — based on how Square / Loyverse POS handle stock
- Products: add, edit, hide, or delete (delete only if the product has no history). Each product can have its own low-stock alert and shelf life. A new product can start with opening stock. Bundles take any items and quantities.
- Stock count: count batch by batch; the app records the difference, and shortages are counted as losses.
- Batch edit: change qty, cost, received date, or expiry (logged).
- Remove with a reason: expired, thawed, damaged, tasting, sample, own use, or missing.
- Stock history: every stock change records who made it and when.
- Money: balance per payment method (Cash/GCash/Maya/Bank) and an end-of-day cash count that records any over or short amount.
Tests: test_ube.py 19/19 and test_ube2.py 17/17.

## v2.0 (2026-11-23) — email login, team invites, cloud sync, Android APK
- `cloud.js`: email-code login (Supabase OTP), "create business" for the owner, invites by email, members join on sign-in, owner can remove members. The app works offline and syncs each record (snapshot diff push, cursor pull, realtime trigger). Signing out clears this phone's copy.
- `config.js`: Supabase URL + publishable key. When these are empty, the app runs on this phone only with no login.
- `supabase/schema.sql`: tables teams/members/invites/records, RLS (members only; owner-only invites and removals), RPCs create_team / accept_invites / set_my_name, realtime publication.
- APK: `Desktop/Claude code/ube-android` (package ph.ubepos.app, key ubepos-release.keystore + keystore.env, **back these up**). It opens https://beaconp413-rgb.github.io/ube-pos/. Download: https://beaconp413-rgb.github.io/UbePOS.apk (committed in the root repo).
- Tests (scratchpad): test_cloud.py (2 phones against a mock backend) 28/28, test_ube.py 19/19, test_ube2.py 17/17, test_ube3.py 11/11.

### Supabase setup (one time)
1. Create project `ube-pos`, region Southeast Asia (Singapore), Free plan.
2. Run `supabase/schema.sql` (SQL editor or migration).
3. Authentication → Emails → Templates: in **Magic Link** and **Confirm signup**, replace the body so it contains the code:
   `<h2>Your Ube POS login code</h2><p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p><p>Type this code in the app. It expires in 1 hour.</p>`
4. Put Project URL + publishable key into `config.js`.
