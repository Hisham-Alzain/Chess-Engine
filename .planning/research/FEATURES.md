# Feature Research

**Domain:** Self-improving chess engine product (play vs engine in browser, live engine output, post-game review, training/rating operations dashboard)
**Researched:** 2026-10-12
**Confidence:** MEDIUM overall. HIGH on play-UX and review conventions (stable, widely documented, Lichess/Chess.com formulas confirmed). MEDIUM on SPRT/Elo-dashboard conventions (fishtest/cutechess practice from established knowledge plus chessprogramming.org; fishtest results page and training.lczero.org were not directly fetched). Flagged inline where a claim is unverified.

**Scope guard:** Everything below respects PROJECT.md Out of Scope. Nothing here proposes net-only play, replay UI for uploaded games, clocks/time controls, accounts/login, adjustable strength, Lichess bot rating, always-on self-play, per-game training, or MCTS/policy-net work.

**Legend:** Complexity = LOW / MEDIUM / HIGH (effort, including backend work it depends on). **[UI]** = UI-heavy, governed by the Khalil React Cookbook (tokens not hardcoded colors, env config, loading/error/empty states on every panel, forwardRef primitives, semantic status colors). **[ENG]** = needs C++ engine/UCI support. **[JOB]** = long-running background job (self-play, training, match, analysis).

---

## Feature Landscape

### Surface 1 - Play against the engine

Reference products: Lichess "Play with the computer", Chess.com vs Computer, Arena/Cute Chess/Banksia GUIs. Users arrive with strong muscle memory from Lichess and Chess.com; deviations from their board behaviour read as bugs.

#### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Responsive board with piece sprites, coordinates, light/dark squares from design tokens **[UI]** | Every chess site has it | MEDIUM | Board must scale down to phone width; force LTR inside the board and move list even if the app runs RTL (existing boilerplate has Arabic i18n; chess notation and files a-h are not mirrored). Pick a permissively licensed board lib and piece set: chessground and the popular cburnett pieces are copyleft (GPL / CC-BY-SA), which matters for a "public product" (MEDIUM confidence, verify at stack time). |
| Click-click AND drag-and-drop move input **[UI]** | Lichess/Chess.com support both; touch users need click-click | MEDIUM | Selecting a piece must work on touch. Illegal drops snap back. Drag ghost + target-square highlight. |
| Legal-move hints (dots on destination squares, ring on capture squares) **[UI]** | Standard on both reference sites | LOW | Legal moves come from the rules authority (chess lib on client or backend). Single source of truth for rules; do not hand-roll move generation in JS and Python separately. |
| Last-move highlight, check highlight, selected-square highlight **[UI]** | Orientation aids; absence feels broken | LOW | Semantic tokens, not hardcoded colours. |
| Pawn promotion picker **[UI]** | Mandatory for correctness | LOW | Modal/popover on the promotion square offering Q/R/B/N; do not silently auto-queen (underpromotion is legal and occasionally decisive). Cancel returns the piece. |
| Special-move correctness: castling (king drag/click two squares, optionally rook click), en passant, promotion with capture | Chess correctness | LOW | Falls out of using a real chess library; needs test coverage, not custom UI. |
| Game-end detection and result banner: checkmate, stalemate, threefold repetition, fifty-move, insufficient material, resignation, agreed draw **[UI]** | Every game must end cleanly | LOW | Banner states reason ("Checkmate - White wins"). Must be unit-tested; wrong draw detection corrupts training labels downstream. |
| Engine moves automatically after user's move, with a visible "engine is thinking" state **[UI][ENG]** | Core loop | MEDIUM | Fixed depth or fixed seconds per move (a v1 constant, not a user-facing strength control). Board is input-locked while engine thinks. Must handle engine failure/timeouts (UCI process crash) with an error state, not a hung board. |
| Choose colour (White / Black / Random) and New Game **[UI]** | Both reference sites | LOW | Black means engine moves first; board orientation flips accordingly. |
| Flip board **[UI]** | Standard control | LOW | Pure UI state; independent of side played. |
| Resign **[UI]** | Standard; games must be finishable | LOW | Confirm dialog. Result is recorded as a loss for the resigner. |
| Offer draw (engine accepts or declines by a simple rule) **[UI][ENG]** | Standard on vs-computer pages | LOW-MEDIUM | Simple rule, e.g. engine accepts when its own eval is at or below 0 after a minimum ply count. Show "Draw declined" feedback. Keep the rule trivial; do not build negotiation. |
| Move list in SAN with click-to-navigate; keyboard arrows step back/forward **[UI]** | Every GUI | MEDIUM | Navigating history during a live game is view-only; must not allow moves from a past position (that is takeback, see below). |
| Material / captured-pieces indicator | Common on Chess.com, present on Lichess | LOW | Nice-to-have polish; cheap. |
| Game save: every finished game persisted server-side with result, move list, timestamp, net version used **[JOB-adjacent]** | PROJECT requirement: "Games played are saved and feed the training pool" | MEDIUM | Must record which network version the engine used (needed for attributing results to nets). Persist on game end AND on abandon (closed tab). |
| Resume an in-progress game after refresh | Users expect a refresh not to lose a game | MEDIUM | Needs server-side game state (also aligns with the "stateless API, real DB" constraint). Without it, accidental refresh destroys a game and its training value. |
| PGN export of a finished game (download and copy) **[UI]** | Standard on every site; also an Arena/Cute Chess baseline | LOW | Include standard seven-tag roster, Result, and engine name + net version as the opponent tag; optionally FEN and eval comments. |
| Game history list (date, colour, result, net version, link to review) **[UI]** | Needed to reach post-game review | LOW | Played games only. Uploaded games must NOT appear as reviewable/replayable entries (Out of Scope). |
| Sound and move animation | Expected polish | LOW | Optional; mute toggle. P3 if schedule is tight. |

#### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| "This game added N positions to the training pool" confirmation after each game | Makes the learning loop visible at the moment the user contributes; ties play to Core Value | LOW | Reads pool delta from the same record that saves the game. |
| Net version badge on the play screen ("Playing: net v7, Elo ~2140 +/- 30") | Users see which brain they face and that it changes | LOW | Reads from rating/promotion state. |
| Takeback (undo last user + engine move) | Both reference sites offer it for casual play | MEDIUM | Not in PROJECT.md. Decision needed: does a taken-back game still feed the pool? Recommend recording only the final move line and flagging the game as "takeback used" so it can be excluded from training if wanted. P2. |

#### Anti-Features (play surface)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Strength slider / handicap / "levels 1-8" | Every vs-computer page has it | Explicitly v2 (Out of Scope); also games against a weakened engine are poor training data and break the Elo story | Fixed full strength; reserve levels for v2 |
| Chess clocks / time controls | Standard on human play sites | Out of Scope (v2); engine thinks fixed depth/seconds | Fixed think budget per move |
| Pondering (engine thinks on the user's time) | Strength gain in GUIs | Burns CPU/battery while idle, conflicts with compute etiquette, muddies "nodes/sec" display | Think only on its own turn |
| Live eval/engine lines while the *user* is deciding | Analysis boards show it | Spoils the play experience and runs the CPU constantly; Lichess disables it in play too | Show engine output while it thinks; show full analysis only in post-game review |
| Human rating / "your Elo" against the engine | Users ask "what rating am I?" | Needs accounts and a stable opponent strength (v2) | Out until accounts exist |
| Premoves, chat, rematch offers, social sharing | Lichess features | Human-vs-human machinery; no value vs a local engine | Skip. Plain "New game" |
| Chess960 / variants, custom start FEN, board editor | Appears in Arena/Cute Chess GUIs | Engine, training data, and rating pipeline are standard chess only; every variant doubles test surface | Standard chess only; reject variant PGNs on upload |
| Opening book UI / tablebase UI | Present in engine GUIs | Not part of the learning story; opening diversity belongs in self-play and match configs, not the play UI | Handle internally (see training surface) |

---

### Surface 2 - Live engine output

Reference: Lichess analysis board (eval bar, engine lines, depth/nps), Arena/Banksia engine info panes, UCI `info` stream.

#### Table Stakes (PROJECT.md requires the first three)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Evaluation bar, always from White's point of view, flips with board orientation **[UI][ENG]** | Universal in analysis UIs | MEDIUM | UCI reports score from the side-to-move; convert to White-POV in one place. Bar height uses the win-probability sigmoid, not linear centipawns, otherwise +3 and +9 look similar and +0.5 looks empty. Numeric label (+0.35, -1.2, M3). Mate scores map to full bar and show "M<n>". |
| Principal variation (best line) in SAN with move numbers, truncated to ~6-10 plies **[UI][ENG]** | Core "see what it's thinking" | MEDIUM | PV arrives as UCI long-algebraic moves; convert to SAN against the position, not blindly. Handle PV that becomes illegal after a replace (stale info lines). |
| Depth (and seldepth optionally) **[UI][ENG]** | PROJECT requirement | LOW | Straight from `info depth`. |
| Nodes and nodes/sec, plus elapsed time **[UI][ENG]** | PROJECT lists nodes/sec; NPS is the headline engine-GUI stat (Arena, Banksia, Lichess all show it) | LOW | Format with k/M suffix. |
| Throttled, coalesced updates (last-write-wins, ~4-10 Hz) **[UI]** | UCI engines emit info lines far faster than a browser should re-render | MEDIUM | Throttle server-side or in the stream consumer. Without it the UI janks and Websocket/SSE traffic balloons. |
| Clear lifecycle states: idle / thinking / final-move-chosen, with the final depth and eval retained after the move **[UI]** | Otherwise the panel blanks at the moment the user wants to read it | LOW | Keep the last search summary on screen until the next search begins. |
| Show/hide toggle for the engine panel **[UI]** | Standard; some users want a clean board | LOW | Persist preference in local storage via the cookbook's config. |

#### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Eval sparkline / history over the game in the play view **[UI]** | Shows momentum as the game progresses; cheap by-product of storing eval per engine move | LOW-MEDIUM | Reuses the same series as the review eval graph. |
| Multi-PV (2-3 lines) | Lichess analysis default; helps judge "only move" positions | HIGH for v1 | Needs UCI `MultiPV` implemented in the C++ search (root-move exclusion; non-trivial and it weakens play if left on). Offer in review/analysis only, never in play mode. Recommend P3 / v1.x. |
| Hover PV move to preview on board | Common polish in analysis UIs | MEDIUM | P3. |
| Hash fill / TT stats / branching factor panel | Appears in engine GUIs | LOW (data) | Teaches the user what search does, aligns with "explain concepts"; P3 only. |
| Plain-language tooltips on each metric ("depth = how many moves ahead it looked") **[UI]** | PROJECT states the user is new to engine concepts and wants every term explained | LOW | Cheap and directly serves a stated project need. P2 but trivial. |

#### Anti-Features (live output)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Multi-PV during play | "See alternatives" | Slows the search and changes play strength | Multi-PV in review only, if at all |
| Raw UCI log console (Arena-style) | Engine-dev familiarity | Noise for a user who is learning; the C++ engine's debug output belongs in server logs | Server logs; optional dev-only panel |
| Per-node/tree visualization | Looks impressive | Huge data volume, high effort, little decision value | Keep depth/PV/NPS |

---

### Surface 3 - Post-game review

Reference: Lichess computer analysis (inaccuracy/mistake/blunder, accuracy %, eval graph, "Learn from your mistakes"), Chess.com Game Review (Expected Points model, Brilliant/Great/Best/Excellent/Good/Inaccuracy/Mistake/Miss/Blunder, accuracy score, key-moments).

#### Classification and accuracy reference (use these exact conventions)

**Win-probability conversion (Lichess, HIGH - published on lichess.org/page/accuracy):**
`Win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * centipawns)) - 1)`. Cap |cp| (Lichess clamps at roughly 1000cp); treat forced mate as 100% / 0%.

**Move classification - recommended: Lichess drop-in-winning-chances convention (MEDIUM-HIGH).** Lichess's Advice code classifies by the *drop in winning chances* caused by the move (from the mover's perspective): inaccuracy at 0.1, mistake at 0.2, blunder at 0.3 on its -1..+1 scale, which equals 5 / 10 / 15 points of Win% on the 0-100 scale (consistent with community measurements of Win% drops). Source of the numbers is a forum quote of lila's `Advice.scala`; exact current constants should be confirmed against the lila repo when implementing.

| Label | Win% drop for the mover (0-100 scale) | Chess.com equivalent (expected points lost, 0-1 scale, HIGH - published help article) |
|-------|--------------------------------------|----------------------------------------|
| Best | 0 (played the engine's top move) | 0.00 |
| Excellent / Good | small drop | 0.00-0.02 excellent, 0.02-0.05 good |
| Inaccuracy | >= 5 | 0.05-0.10 |
| Mistake | >= 10 | 0.10-0.20 |
| Blunder | >= 15 | 0.20-1.00 |

Recommendation: use the Lichess-style three bad-move labels plus "best move" with the above Win% thresholds, make them named constants in one shared module, and expose them as a read-only legend in the review UI. Chess.com's version additionally varies "Great"/"Brilliant" by player rating and uses a rating-dependent model, which is not reproducible without data; skip those.

**Accuracy % (Lichess, HIGH - published formula):** per-move `Accuracy% = 103.1668 * exp(-0.04354 * (WinBefore - WinAfter)) - 3.1669` (the page shows `- 3`; verify the exact constant against lichess.org/page/accuracy at implementation), clamped to 0-100, where Win% values are from the mover's perspective. Game accuracy for a side is the average of a volatility-weighted mean and the harmonic mean of that side's move accuracies (volatility = standard deviation of win% inside ~10-ply windows). The harmonic mean makes a single blunder drag the number down, which matches how players perceive a game. Simplification option for v1: harmonic mean only (documented as approximate).

#### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Review launched from game history / end-of-game screen; engine analyses every position of the game **[JOB][ENG]** | PROJECT requirement | MEDIUM-HIGH | Fixed depth or ~0.3-1 s per position. A 70-move game is ~140 positions, so about 1-2 minutes: this is a background job with a progress bar, cancellable, and it competes for CPU with self-play/training (single-job lock). Run on demand rather than automatically after every game (compute etiquette). |
| Cache the analysis in the database (per ply: eval, best move, PV, depth, net version) | Re-opening must be instant; avoids recomputation | MEDIUM | Key by game id + analysis settings + net version. Re-analysis after a net promotion is an explicit action, not automatic. |
| Step-through: first/prev/next/last buttons, arrow keys, click on move list **[UI]** | Every review UI | MEDIUM | Board, eval bar, and best line update together. |
| Per-move classification markers in the move list and on the board (colour + symbol; never colour alone, for accessibility) **[UI]** | The point of review | MEDIUM | Semantic status tokens (info/warn/danger). Shows `?!`, `?`, `??`-style glyphs or icons. |
| Best-move display for each flagged move: arrow on board plus SAN and eval of the best move vs the played move **[UI]** | PROJECT: "better moves" | MEDIUM | Take from the stored per-ply best move; show the PV after the best move. |
| Evaluation graph over the whole game, click to jump to a ply **[UI]** | Lichess and Chess.com both lead with it | MEDIUM | X = ply, Y = Win% (or capped cp). Mark the classified moves on the line. Use the cookbook's chart discipline (tokens for colours, accessible tooltips). |
| Accuracy % per side with the classification counts (e.g. "White: 84% - 1 blunder, 2 mistakes, 3 inaccuracies") **[UI]** | Both reference sites show it | LOW | Straight from the formulas above. |
| Handling of the engine's own moves | Users see the engine "blunder" in review | LOW | Classify both sides identically. Expect the engine to be flagged occasionally: review depth is typically deeper than play depth, and that is informative, not a bug. State the review depth in the UI so the discrepancy is explained. |
| Empty/loading/error states: analysis running, failed, cancelled, game too short **[UI]** | Cookbook rule; analysis can fail | LOW | |

#### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| "Jump to next mistake/blunder" button | Fastest route to value in a review; trivial once classification exists | LOW | P2 but near-free. |
| "Retry from here" / "Learn from your mistakes" (replay from the position before a mistake and try to find the best move) | Lichess's best-loved review feature | MEDIUM-HIGH | Needs a mini-play mode; P3 for v1, strong v1.x candidate. |
| Show which net version produced the game and which version analysed it | Makes the review honest as the net changes | LOW | Reuses stored metadata. |
| Opening name (ECO) tag at the top of the game | Chess.com and Lichess show it | LOW-MEDIUM | Needs an ECO table (open data, e.g. lichess chess-openings); P3. |
| Choose the reviewing engine (own net vs Stockfish) | An early, weak net judges games poorly; Stockfish as reviewer gives trustworthy labels | MEDIUM | Not required by PROJECT; mention as a risk mitigation: early-network review labels are only as good as the evaluation. P3. |

#### Anti-Features (review)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Brilliant / Great / Miss move labels (Chess.com style) | Delighters on Chess.com | Chess.com's thresholds depend on player rating and sacrifice/only-move heuristics that are not published exactly; wrong labels destroy trust | Best / Inaccuracy / Mistake / Blunder only |
| Replay/review of uploaded PGNs | "Review any game I paste" | Explicitly Out of Scope; uploads are ingestion-only | Keep reviewable games = games played in this app |
| Free-form analysis board (arbitrary positions, engine at infinite depth) | Lichess analysis board | A different product surface; infinite search is un-etiquette-friendly | Defer past v1 |
| LLM/natural-language move explanations, coach chat | Trendy | Fabricated explanations are worse than none; heavy scope | Show eval + best line only |
| Auto-analyse every game on completion | Convenience | Competes for CPU with training/self-play; wastes battery on games nobody reviews | On-demand with cache |
| Rating-adjusted move quality | Chess.com does it | No human rating exists without accounts | Fixed thresholds |

---

### Surface 4 - Training and learning operations UI

Reference: fishtest (SPRT test pages: W/D/L, pentanomial, Elo +/- error, LOS, LLR vs bounds), cutechess-cli/SPRT match output, Leela training site (network list, strength-over-versions chart, game counts), Lichess opening explorer for dataset framing. Note: Leela does not gate nets with a promotion match; it ranks networks after the fact by Elo (MEDIUM confidence, not verified). This project's gating is the AlphaGo-Zero/classic-gating style the user wants, with fishtest-style statistics to make the decision defensible.

#### Statistics conventions to build the UI around (MEDIUM; my arithmetic, verify in implementation)

- Elo difference from match score s: `Elo = -400 * log10(1/s - 1)`.
- Error bars matter a lot at laptop-scale game counts. With ~40% draws, ~400 games gives roughly +/-26 Elo at 95% confidence; ~100 games gives roughly +/-53. A +20 Elo improvement therefore cannot be seen in 100 games. The UI must show error bars or the "Elo went up" claim is dishonest.
- SPRT (sequential probability ratio test) decides a candidate as soon as evidence is strong enough instead of fixing the game count. With alpha = beta = 0.05 the log-likelihood-ratio (LLR) bounds are about -2.94 and +2.94 (chessprogramming.org/Sequential_Probability_Ratio_Test, MEDIUM-HIGH). Fishtest uses a pentanomial model over colour-reversed game pairs, which gives tighter confidence than counting single games; this requires paired openings with reversed colours.
- Rule for a promotion match: SPRT with H0 = "no stronger" (elo0 = 0) and H1 = "at least +N Elo" (elo1 small positive, e.g. +10 to +20, tune from compute budget), plus a hard maximum game count; **inconclusive at the cap = reject** (the live net stays). This is the "statistically meaningful margin" in PROJECT.md.
- Opening diversity is mandatory in matches and self-play: a deterministic engine replays the same game from the start position. Matches use a set of short opening lines (book), each played twice with colours reversed. Self-play adds randomisation (e.g. temperature on early moves / random opening plies) so the data is varied.
- Rating against Stockfish: use Stockfish's `UCI_LimitStrength` + `UCI_Elo`. Stockfish documents UCI_Elo as calibrated at 60s+0.6s per game against CCRL 40/4 (MEDIUM-HIGH); lower bound about 1320 reported by users (unverified upper bound; check the installed binary). The calibration is loose and time-control dependent, so the number is "Elo relative to this Stockfish configuration", not absolute FIDE or Lichess Elo. A performance Elo is only informative when the match score is between roughly 20% and 80%, so the rating job should pick the 2-3 Stockfish levels that bracket the current strength and combine them, rather than testing every level.

#### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Single "job status" bar visible on all training pages: idle / self-play / training / promotion match / rating match / analysis, with progress and Cancel **[UI][JOB]** | One laptop, one GPU/CPU budget; users must never wonder what is running | MEDIUM | Backed by one job table with a global lock (only one heavy job at a time). Jobs survive a page refresh because state lives in the database, not the browser. |
| **Data pool panel**: total games and positions, breakdown by source (Lichess bootstrap / played by user / self-play / uploaded), games since the last training run, minimum games needed for a batch, progress bar toward "ready to train" **[UI]** | PROJECT: "user can see the training history: pools" | LOW-MEDIUM | Query over stored games. Empty state on day one must be designed (pool exists only after bootstrap). |
| **"Train now" button** with disabled-with-reason states (pool too small, another job running, no GPU) **[UI][JOB]** | PROJECT requires manual trigger | MEDIUM | Disabled reasons shown inline, not as silent greyed buttons. Confirmation shows pool size and estimated duration. |
| **Training run list**: id, started/ended, status (queued/running/succeeded/failed/cancelled), pool snapshot used, number of positions, epochs, final train/validation loss, duration, resulting candidate id **[UI][JOB]** | PROJECT: "runs" | MEDIUM | Immutable pool snapshot per run (record which game ids or a cut-off) so each candidate is reproducible and explainable. |
| **Candidate nets list**: version id, parent net, created from which run, status (pending / promoted / rejected / inconclusive), promotion match summary, "current live net" badge **[UI]** | PROJECT: "candidates" | LOW-MEDIUM | Net files versioned on disk; DB holds metadata and checksum. |
| **Promotion match result view**: games played / max, W-D-L, score %, Elo difference with 95% interval, LOS (likelihood of superiority, optional), SPRT LLR with the two bounds and a status ("continuing / accepted / rejected / inconclusive at cap"), final decision and reason in a sentence **[UI][JOB]** | PROJECT: "wins by a statistically meaningful margin"; fishtest/cutechess convention | MEDIUM-HIGH | Live-updating while the match runs (poll every few seconds is enough). Show the decision rule used (elo0, elo1, alpha/beta, max games, TC, openings) for reproducibility. |
| Automatic promotion on accept: swap the live net atomically, keep the previous net, record the event **[JOB]** | PROJECT gating | MEDIUM | The engine process must pick up the new net without a half-written file (write to temp, checksum, rename). Rollback is only possible if the old file is kept. |
| **Rating dashboard**: headline "Current Elo: 2140 +/- 30 (vs Stockfish levels A-C)", games behind the number, date, net version it belongs to **[UI]** | PROJECT: dashboard shows current rating | MEDIUM | The "stale" case (current live net not yet rated) must be explicit. |
| **Rating history chart**: x = net version (in promotion order, not wall-clock), y = Elo, with +/- error band or whiskers per point, promoted versions marked **[UI]** | PROJECT: "history over network versions"; v1-done criterion | MEDIUM | Needs a version-0 baseline point (the bootstrap net) or the chart has nothing to rise from. Error bars are essential for the "went up because of training" claim. Chart discipline per the cookbook (token colours, accessible labels, empty/loading/error). |
| **Rating match (Elo vs Stockfish levels) runner**: choose or auto-pick levels, show per-level W/D/L, score, games, and the computed rating **[UI][JOB]** | PROJECT: Elo measured against capped Stockfish | HIGH | Requires Stockfish installed and callable over UCI, paired openings, per-level game cap, and Elo-from-results computation. Stores the exact Stockfish build, level, TC, threads, hash, and openings used with each rating record. |
| **Self-play session**: start form with target game count (validated min/max, sensible default), start button, live progress bar (n of target), games/hour, ETA, current W/D/L tally, Stop (keeps finished games), completion summary ("N games added to pool") **[UI][JOB]** | PROJECT requirement | MEDIUM-HIGH | Runs N parallel games across cores (config, not a user control). Self-play game records are streamed into the pool as they finish so Stop loses nothing. Survives page refresh. Disabled while another heavy job runs. |
| **PGN upload**: file picker/drag-drop (multi-file), size cap, progress for large files, then an ingestion report **[UI][JOB]** | PROJECT requirement | MEDIUM-HIGH | Parse server-side with a real PGN parser; stream so a 200 MB file does not exhaust 16 GB RAM. |
| **PGN validation report**: totals for parsed / accepted / duplicate-skipped / rejected, rejection reasons grouped (illegal move, missing result, variant/Chess960, too short, parse error) with game index and line number for the first few **[UI]** | Users must know why games were dropped | MEDIUM | Per-game best-effort (one bad game does not discard the file). Keep a batch record in history. |
| **Dedup on ingest**: hash of the normalised move sequence (headers ignored) checked against the whole pool including games played in-app; report count skipped **[JOB]** | PROJECT: "PGN upload with validation and dedup" | MEDIUM | Hash of the move list, not tags (tags differ across sources). Dedup before training so duplicates do not over-weight one game. |
| **Training history view**: one place linking pool -> run -> candidate -> promotion result -> rating, newest first **[UI]** | PROJECT: "see the training history" | MEDIUM | Tables with deep links are sufficient; no graph visualisation needed. |
| Honest empty, loading, error, and partial-failure states on every panel **[UI]** | Cookbook mandatory | LOW per panel, MEDIUM in total | A fresh install shows an empty dashboard; design it as the first screen, not an afterthought. |

#### Differentiators

These are where this product competes: making "Elo rose because of training" a *measured, explainable* fact (Core Value).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Plain-language decision sentence** on each promotion ("Candidate v8 beat v7: 58% over 412 games, about +55 Elo; we are 95% sure it is better. Promoted.") with an "explain this number" popover for Elo, error bar, SPRT, LLR **[UI]** | The user is new to engine/ML vocabulary and asked for every concept explained; also the single biggest clarity gain over fishtest-style raw tables | LOW-MEDIUM | Static glossary + templated sentence from the match record. |
| **Improvement attribution**: show the head-to-head promotion Elo between consecutive nets next to the two Stockfish-anchored ratings, and flag "significant rise" only when the intervals separate **[UI]** | Head-to-head is statistically much tighter than comparing two noisy anchored ratings; directly serves the v1-done criterion | MEDIUM | Needs both measurements stored per net. |
| **Provenance panel per net/rating**: pool snapshot (counts per source), run config, match config, Stockfish build/level/TC, openings, seeds **[UI]** | Reproducibility is the opposite of "learning loop as hope" | LOW-MEDIUM | Mostly rendering stored metadata. |
| **Elo vs training-data size** (x = cumulative games in pool) as a second chart view | Shows the data-to-strength relationship, "watch that number rise because of training" | LOW-MEDIUM | Same data as the history chart with a different x-axis. P2. |
| **Rollback** to a previous promoted net (explicit button, logged) | Cheap insurance against a mis-gated net | MEDIUM | Needs versioned net files retained and a clear audit entry. P2. |
| **Per-source weighting / quality filter for uploads** (e.g. minimum player Elo from PGN headers, drop time-forfeit / abandoned results) | Result-labelled games from weak players or forfeits are noisy labels; Stockfish itself does not train on game results | MEDIUM | Config-level in v1; UI toggle P3. Important correctness concern behind "ingestion". |
| **Loss-curve chart** (train and validation loss per epoch) in the run detail view **[UI]** | Standard in ML dashboards; fastest overfit detector | MEDIUM | Per-epoch rather than per-step to keep data small. P2. |
| **Active gating policy card** (read-only): SPRT bounds, max games, minimum pool size, openings set, time control **[UI]** | Transparency of the rules; no hidden knobs | LOW | Editing stays in config files for v1. |
| Optional "auto-train when ready" toggle, **default OFF** | Convenience without violating compute etiquette | LOW-MEDIUM | See tension below. |
| Peek at the latest self-play game (board snapshot, no replay) **[UI]** | Fun, makes self-play tangible | MEDIUM | P3. Be careful: this must not turn into a replay UI for uploads. |

#### Anti-Features (training / ops)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Generic tournament manager (Arena / Cute Chess style: add arbitrary engines, any pairings, custom TCs) | Familiar from engine GUIs | Huge UI surface; only three match types matter (promotion, rating, optional smoke test) | Fixed job types with config-file parameters |
| Per-game online training or "update after each game" | Feels responsive | Out of Scope; noisy and damaging | Batches + gating |
| Always-on / idle self-play, background auto-matches | "It trains while I sleep" | Out of Scope; laptop thermals and battery | On-demand sessions with a target count |
| Hyperparameter editor and arbitrary run configs in the UI | Power-user ML tooling | Risk of invalid configs, support burden, and unreproducible runs | Named presets in config; show settings read-only |
| Distributed / volunteer self-play (Leela-style) or fishtest-style worker network | Scales data | Multi-user infrastructure with no v1 users; accounts are v2 | Single-machine workers |
| Round-robin Elo ladder between all historical nets | Pretty ladder | Quadratic compute; consecutive head-to-head + Stockfish anchors suffice | Show lineage with consecutive deltas |
| Streaming per-step loss over websockets | Looks live | Complexity for no decision value | Poll per epoch |
| Visual replay of uploaded games / "watch an uploaded game vs engine" | Natural extension | Explicitly Out of Scope | Ingestion report only |
| Net-only strength mode in Elo dashboard ("net alone is X Elo") | Curiosity | Net-only play was dropped; an eval net cannot pick moves without search | Rate the full engine only |
| Absolute Elo claims ("2300 FIDE") | Marketing | Stockfish levels are loosely calibrated and TC-dependent; claims would be wrong | Label as "Elo vs Stockfish config X" with config shown |
| Lichess-bot online rating, account-linked history, public leaderboards | Public-product ambition | v2 per PROJECT | Local Stockfish yardstick only |
| Email / push notifications for finished overnight runs | Long jobs | Scope; browser tab may be closed anyway | In-app status on next visit; optional browser notification P3 |

---

## Requirements-Impacting Tensions (resolve in requirements)

1. **"Training runs in batches once the pool has enough games" versus "compute etiquette: on-demand, never always-on."** An auto-fire at the threshold would start a GPU job unprompted. Recommended resolution: reaching the threshold only sets a "Ready to train" state; training starts only on the manual button, with an opt-in "auto-train when ready" toggle defaulting to off.
2. **Gating needs enough compute to be decisive.** At roughly 12 to 15 s per short game and about 8 parallel games (my estimate for this CPU at fast per-move budgets, not measured), ~2000 games per hour is plausible, so a 400-game promotion match is minutes, not hours. This keeps SPRT feasible. It also means the match and rating jobs, self-play, training, and review analysis all contend for the same machine: the single-job lock is not optional.
3. **Reviewed games must not blur into uploaded games.** The game history lists played games only; ingestion batches are a separate list with counts, never a board. Otherwise the replay UI Out-of-Scope rule is violated by accident.
4. **Board LTR inside an RTL-capable app.** Existing boilerplate has Arabic i18n; PROJECT.md does not require translation in v1. Recommendation: English-only strings in v1, but force LTR for board, coordinates, and move notation so adding Arabic later does not break chess rendering.
5. **Takeback and "game feeds training pool."** Decide whether games using takeback are excluded from the pool (recommended: flag and exclude by default).

---

## Feature Dependencies

```
Rules library (single source of truth for legality, SAN, game end)
    └──requires──> Board UI (move input, hints, promotion)
                       └──requires──> Play loop (engine reply) ──requires──> C++ UCI engine
                                                                        └──requires──> bootstrap net

Live engine panel (eval bar, PV, depth, nps)
    └──requires──> UCI `info` streaming (throttled) ──requires──> C++ engine emits depth/score/nodes/pv

Game save ──requires──> server-side game state + DB schema
    ├──enables──> Game history ──enables──> Post-game review entry
    ├──enables──> PGN export
    └──enables──> Data pool (played-game source)

Post-game review
    ├──requires──> Game save + cached analysis table
    ├──requires──> Analysis job (engine at fixed depth over all plies) ──requires──> Job runner + global lock
    ├──requires──> Win% conversion + classification thresholds (shared constants module)
    └──enhances──> Accuracy %, eval graph, jump-to-next-mistake

Data pool
    ├──requires──> Bootstrap import (Lichess database) for the initial state
    ├──requires──> PGN ingest (validation, dedup) for the uploaded source
    └──requires──> Self-play session for the self-play source

Self-play session ──requires──> UCI engine + opening diversity + Job runner + global lock
Training run ──requires──> Data pool snapshot + Python trainer + GPU + Job runner + global lock
Candidate net ──requires──> Training run + versioned net files
Promotion match ──requires──> Candidate net + paired-opening match runner + SPRT/Elo computation
Promotion (swap live net) ──requires──> Promotion match accept + atomic file swap + engine reload
Rating match ──requires──> Stockfish installed + match runner + Elo-from-results + stored match config
Rating history chart ──requires──> Rating match results per net version + version-0 baseline
Improvement attribution ──requires──> Promotion match results AND rating match results per net

Job status bar ──enhances──> Self-play, Training, Matches, Review analysis (all share the job table)
Plain-language explanations ──enhances──> Promotion view, Rating dashboard, Live engine panel

Multi-PV ──conflicts──> Play mode (weakens play); allowed only in review/analysis
Replay UI for uploads ──conflicts──> Out of Scope (never build)
Strength slider ──conflicts──> Elo story + Out of Scope (v2)
```

### Dependency Notes

- **Review requires a job runner:** a 1-2 minute analysis cannot be an inline HTTP request. The same job table, progress reporting, cancel, and global lock serve self-play, training, matches, and review. Build that once, early.
- **Rating chart requires a baseline:** the bootstrap net must be rated (version 0) before the chart has a first point and before any rise can be claimed.
- **Promotion match requires paired openings:** without an opening set, the engine repeats one game and the statistics are meaningless. The opening set is a data asset to prepare in the matches phase.
- **Dedup requires an index:** hashing the move list on write and keeping a unique index on it keeps ingest fast and enforces dedup across sources, including games played in the app.
- **Shared constants:** classification thresholds, Win% curve, SPRT parameters, and Stockfish level list must each live in one module (cookbook: single source for shared constants); the UI reads them from the API rather than redefining.
- **UI-heavy and cookbook-governed:** board, eval bar, PV panel, eval graph, move list, job status bar, pool panel, run/candidate tables, match view, rating dashboard + history chart, self-play form + progress, PGN upload + report. Use `react-ui-implementation` for each component; use `react-data-layer` for the API client, polling/streaming, and 422 error handling (upload validation and form errors).

---

## MVP Definition

### Launch With (v1)

Everything below traces to PROJECT.md Active requirements.

- [ ] Board with click/drag input, legal-move hints, promotion picker, last-move/check highlights, flip, new game, colour choice, resign, draw offer, game-end detection - core play loop
- [ ] Engine reply with "thinking" state and live eval bar (White POV, sigmoid scale), PV in SAN, depth, nodes, nps (throttled) - PROJECT live-output requirement
- [ ] Game save (with net version), resume after refresh, game history, PGN export - feeds the pool
- [ ] Post-game review: background analysis job with progress and cache, step-through, Lichess-style Win% classification (inaccuracy / mistake / blunder / best), best-move arrow, eval graph, accuracy %
- [ ] Data pool panel with source breakdown and a "Ready to train" state
- [ ] PGN upload with validation report and dedup (ingestion only)
- [ ] Self-play session with target count, progress, stop, completion summary
- [ ] Train now button, training run list, candidate list
- [ ] Promotion match with SPRT + Elo +/- error, reject on inconclusive, atomic promotion
- [ ] Rating match vs bracketing Stockfish levels, rating dashboard, rating history chart with error bars and a version-0 baseline
- [ ] Single job status bar and global job lock
- [ ] Plain-language explanations on every training/rating number (cheap, aligns with stated user need)

### Add After Validation (v1.x)

- [ ] Takeback (with exclude-from-pool flag) - once the play loop is solid
- [ ] Jump to next mistake - trivial add to review
- [ ] "Retry from here" mode - after classification is trusted
- [ ] Elo vs training-data-size chart, loss-curve chart, rollback, auto-train toggle
- [ ] Multi-PV in review only - after the C++ engine supports `MultiPV`
- [ ] Upload quality filters in UI (min player Elo, drop forfeits)

### Future Consideration (v2+)

- [ ] Adjustable strength, clocks, accounts, Lichess bot rating, public sharing - per PROJECT Out of Scope
- [ ] Free analysis board, opening explorer, ECO names, choice of reviewing engine
- [ ] Policy-head work, distributed self-play

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Board + move input + legal hints + promotion | HIGH | MEDIUM | P1 |
| Engine reply + live eval/PV/depth/nps | HIGH | MEDIUM | P1 |
| Game end detection, resign, draw, flip, new game | HIGH | LOW | P1 |
| Game save + history + PGN export | HIGH | MEDIUM | P1 |
| Resume game after refresh | MEDIUM | MEDIUM | P1 |
| Job runner + status bar + global lock | HIGH | MEDIUM | P1 |
| Post-game review (classification, accuracy, graph, step-through) | HIGH | HIGH | P1 |
| Data pool panel | HIGH | LOW-MEDIUM | P1 |
| PGN upload + validation + dedup | HIGH | MEDIUM-HIGH | P1 |
| Self-play session | HIGH | MEDIUM-HIGH | P1 |
| Train now + run list + candidate list | HIGH | MEDIUM | P1 |
| Promotion match view with SPRT + Elo + error bars | HIGH | MEDIUM-HIGH | P1 |
| Rating dashboard + history chart + Stockfish rating job | HIGH | HIGH | P1 |
| Plain-language explanations | HIGH | LOW-MEDIUM | P1 |
| Improvement attribution | HIGH | MEDIUM | P2 |
| Provenance panel / policy card | MEDIUM | LOW-MEDIUM | P2 |
| Takeback | MEDIUM | MEDIUM | P2 |
| Eval sparkline in play, jump-to-next-mistake, rollback, loss curves, Elo-vs-data chart | MEDIUM | LOW-MEDIUM | P2 |
| Multi-PV (review only) | MEDIUM | HIGH | P3 |
| Retry from here | MEDIUM | MEDIUM-HIGH | P3 |
| Sound/animation, material counter, hover-PV preview, ECO names, peek at self-play | LOW | LOW-MEDIUM | P3 |

**Priority key:** P1 must have for launch; P2 should have when possible; P3 nice to have.

---

## Competitor Feature Analysis

| Feature | Lichess / Chess.com | Engine GUIs (Arena, Cute Chess, Banksia) | Fishtest / Leela | Our Approach |
|---------|---------------------|-------------------------------------------|------------------|--------------|
| Board input | Click + drag, dots, promotion modal, premove | Drag/drop, basic | None | Click + drag, dots, promotion modal; skip premove |
| Engine strength | Levels / Stockfish levels | Full engine, UCI options | N/A | Always full strength (v1) |
| Eval bar / PV / depth / NPS | Eval bar, lines, depth, nps in analysis | Detailed info pane, raw UCI | N/A | Compact panel in play; same data, plain-language tooltips |
| Multi-PV | Yes in analysis | Yes | N/A | Review only, post-v1 |
| Move quality labels | Lichess: inaccuracy / mistake / blunder; Chess.com: 9 classes incl. Brilliant/Great | Annotations optional | N/A | Lichess convention (5 / 10 / 15 Win% points); skip Brilliant/Great |
| Accuracy % | Yes (Lichess formula published) | No | N/A | Lichess formula |
| Eval graph | Yes | Rare | N/A | Yes, click to jump |
| Game export | PGN, FEN | PGN | N/A | PGN + copy |
| Engine-vs-engine matches | Not available | Tournament managers; cutechess-cli with SPRT | Fishtest SPRT with pentanomial stats, LOS, LLR | Fixed promotion and rating matches; SPRT, Elo +/- error, LLR shown with a plain-language verdict |
| Network/training dashboard | N/A | N/A | Leela: network list, strength over versions, game counts; fishtest: test pages | Pool, runs, candidates, promotions, rating history in one flow |
| Rating | Human ratings | Engine rating lists (CCRL) | Elo vs gauntlet / self-play | Elo vs capped Stockfish levels, with CI and config shown |
| Data ingestion | Lichess DB export | PGN databases in GUI | N/A | Upload, validate, dedupe, report; no replay |

---

## Sources

- Lichess accuracy metric page - https://lichess.org/page/accuracy (Win% formula, accuracy formula, harmonic + volatility-weighted aggregation) - HIGH
- Lichess forum thread quoting lila Advice.scala (winning-chance thresholds 0.1 / 0.2 / 0.3) - https://lichess.org/forum/general-chess-discussion/what-constitutes-an-inaccuracy - MEDIUM; confirm constants against the lila repo
- Lichess Volatility explainer - https://lichess.org/@/jk_182/blog/quantifying-volatility-of-chess-games/H6MWvX98 - MEDIUM
- Chess.com support: How are moves classified (Expected Points model, 0.00 / 0.02 / 0.05 / 0.10 / 0.20 bands) - https://support.chess.com/en/articles/8572705 - HIGH (official)
- Chess.com support: Game Review / accuracy - https://support.chess.com/en/articles/8584089-how-does-game-review-work - HIGH (official)
- Chessprogramming wiki: Sequential Probability Ratio Test - https://www.chessprogramming.org/Sequential_Probability_Ratio_Test - MEDIUM-HIGH
- TalkChess SPRT bounds discussion (LLR bounds of about +/-2.944 at alpha = beta = 0.05) - https://talkchess.com/viewtopic.php?p=533132 - MEDIUM
- vdbergh/pentanomial and simul (fishtest-style GSPRT, pentanomial) - https://github.com/vdbergh/pentanomial - MEDIUM
- Stockfish UCI_Elo calibration notes (60s+0.6s, CCRL 40/4 anchor, loose anchoring, ~1320 floor) - https://talkchess.com/viewtopic.php?p=951062 and the Stockfish Readme - MEDIUM; upper bound and exact range not verified
- Leela self-play Elo caveats (relative, not directly comparable to alpha-beta engines) - https://encyclopedia.pub/entry/30569 - LOW-MEDIUM
- Not fetched or unverified: fishtest results page layout, training.lczero.org layout, Arena/Cute Chess/Banksia feature lists (from established domain knowledge; MEDIUM), Leela's no-gating policy (MEDIUM), board/piece library licenses (verify at stack time)

---
*Feature research for: self-improving chess engine product (play, live output, review, training operations, Stockfish-anchored rating)*
*Researched: 2026-10-12*
