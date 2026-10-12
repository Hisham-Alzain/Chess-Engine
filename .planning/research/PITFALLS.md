# Pitfalls Research

**Domain:** Self-improving chess engine (C++ alpha-beta + NNUE-style eval, Python training, Lichess bootstrap, self-play + promotion gating, Elo vs Stockfish levels, web play UI) built by a small team on one Windows laptop (RTX 3060 6 GB, 8C/16T Ryzen, 16 GB RAM)
**Researched:** 2026-10-12
**Confidence:** MEDIUM-HIGH (engine-dev and NNUE-training pitfalls are long-established community knowledge; Stockfish-specific behavior and Lichess dataset specifics are MEDIUM and flagged where they should be re-verified against the pinned versions)

## Read This First: Why Elo Curves Go Flat

The project's Core Value is "measured Elo goes up because of games it played." A flat curve almost never has one cause. In rough order of how often it happens to projects like this:

1. **The measurement cannot see the change.** Too few games, saturated opponents (score near 0% or 100%), same openings, load/thermal noise. You may be improving and not know, or "improving" and be seeing noise.
2. **The training signal carries no new information.** Labelling self-play positions with the same-depth search of the same net teaches the net what it already knows.
3. **The C++ net is not the PyTorch net.** Feature-index, perspective, or quantization disagreement means every candidate you "train" is not the thing being played.
4. **The gate is broken in one of two directions.** Too loose, so noise gets promoted (random-walk Elo that looks like progress, then regresses). Too strict, so real gains of 5 to 15 Elo are rejected forever.
5. **The bootstrap sets the ceiling.** A small net trained on a modest, noisy dataset caps out; self-play on a laptop adds a small, shrinking increment on top.

Every pitfall below maps back to one of these. The roadmap implication: **build the measurement harness and prove it can detect a known difference before building the learning loop.**

---

## Critical Pitfalls

### Pitfall 1: Move generator is "mostly right" and bugs surface weeks later as inexplicable losses

**What goes wrong:**
A move-gen bug (illegal castling through check, castling rights not cleared when a rook is captured on its home square, en-passant discovered check along the rank, promotion-capture flags, double-check handling) corrupts a small fraction of games. The engine then occasionally plays an illegal move, crashes, or misses a legal move. Because search results look plausible, the bug is blamed on "eval" or "training" and weeks are wasted tuning the wrong layer. In self-play the damage is worse: illegal-move games get recorded as training data.

**Why it happens:**
Perft is skipped or only run from the start position at depth 3-4, which passes with many bugs. Bugs live in rare move types.

**How to avoid:**
- Perft suite as a CI-style gate before any search work: start position, Kiwipete, and the standard CPW positions 3 to 6 at depth 5-6 where feasible, plus a few hundred random-position perft-vs-python-chess comparisons (python-chess is a convenient oracle, validate legal-move set equality at every node of random playouts, not just counts).
- `perft divide` against python-chess when a count mismatches; bisect to the move.
- Incremental Zobrist key and (later) NNUE accumulator must be asserted equal to a from-scratch recompute after every make/unmake in a debug build (run this inside the perft walk).
- Repetition and 50-move detection tested explicitly (including repetition across the root: positions from the `position ... moves` list must be pushed into the history).

**Warning signs:**
Engine "randomly" loses on time/forfeits for illegal move in cutechess; node counts at fixed depth change after a "refactor that shouldn't matter"; python-chess raises `IllegalMoveError`/`ValueError` when replaying engine games.

**Phase to address:** Engine core (first phase). Perft + random-playout oracle test is an exit criterion, not a nice-to-have.

---

### Pitfall 2: Hash table and search "work" but are subtly unsound

**What goes wrong:**
- TT move from a key collision is illegal in the current position and gets played or crashes `make_move`.
- Mate scores stored in the TT without ply adjustment, so the engine "sees" mates that are not there or plays a longer mate than necessary.
- Scores from an aborted (time/node-limit) iteration are stored in the TT or used for the final `bestmove`, producing blunders when `stop` arrives.
- Aspiration window fail-high/fail-low loops: window widened too slowly (or reset to the same size), search re-runs the same depth dozens of times, or a bound result is reported as an exact score.
- Null-move pruning in zugzwang/pawn-only endings, reductions that use the wrong improving flag, quiescence search without check handling or without a depth bound, all create instabilities that only show up as Elo that stops scaling with depth.
- Evaluation sign confusion (score from White's POV in one place, side-to-move in another) shows up as the engine playing well for one color and badly for the other.

**Why it happens:**
Each technique is individually simple; the interactions are not. Hobby engines copy snippets without the invariants (store bounds with the right type, adjust mate scores, validate TT moves).

**How to avoid:**
- Validate the TT move for pseudo-legality before using it; use a 64-bit key and store enough check bits. Treat TT as untrusted.
- Convert mate scores to/from "distance from node" on store/probe.
- Only trust a completed iteration for the result; the previous completed iteration's best move is the fallback. Never store results after the stop flag is set.
- Aspiration: start narrow (e.g. 10-20 cp at depth >= 5), widen exponentially on failure (double the delta), fall back to a full window after a few failures; handle `lowerbound`/`upperbound` properly; never print bound scores as final.
- Search sanity suite: mate-in-N positions, known zugzwang positions, WAC/ECM-style tactical set at fixed time as a regression number; a **bench** command (fixed positions, fixed depth, prints total nodes) whose node count is committed so unintended search changes are visible.
- Self-test: engine vs. a copy of itself with one feature disabled at fixed nodes; each feature should show a non-negative result before being kept.

**Warning signs:**
Search time per depth is erratic; PV changes every iteration without eval change; evaluation jumps by hundreds of cp between depth N and N+1 in quiet positions; engine "finds" mate then plays something else; node count differs run to run at fixed depth with 1 thread (nondeterminism = uninitialized memory or TT state leak).

**Phase to address:** Engine core; re-checked in the Match/Rating harness phase (the self-test uses the harness).

---

### Pitfall 3: Net output scale does not fit the search's pruning margins or mate range

**What goes wrong:**
Futility/razoring/null-move margins, aspiration deltas, and "winning" adjudication thresholds are tuned in centipawns against a hand-crafted eval. A net trained on a sigmoid-scaled loss emits values in different units or a squashed range, so pruning is too aggressive or too timid and search strength drops even though the net "has lower loss." A net output near +/-30000 also collides with mate scores.

**Why it happens:**
The loss space (sigmoid of eval/K) and the search space (centipawns) are different; the scale constant K is chosen once and forgotten.

**How to avoid:**
- Define one internal unit (cp, with 100 ~ one pawn at typical material) and fit the training sigmoid constant K on the actual dataset (minimize error of result prediction vs. score). Store K and the output scale in the net file header; C++ reads it.
- Clamp net output to a safe range well inside the mate bound (e.g. +/-20000 when mate is 32000 minus ply).
- Evaluate material-only and PST-only baselines through the same search so the pruning constants are known-good before the net exists; the net replaces a working evaluator, not a missing one.
- Only call the net on non-check nodes (stand-pat); in-check positions must not use static eval.

**Warning signs:**
Better validation loss but worse fixed-node match results; eval bar shows +/-3 for obviously equal positions; average |eval| in self-play positions far from the training label distribution.

**Phase to address:** Net architecture + inference phase; verified in Bootstrap phase by a fixed-node match against the classical-eval baseline.

---

### Pitfall 4: UCI implementation breaks cutechess-cli / fastchess / python-chess in ways that look like random flakiness

**What goes wrong:**
- Output not flushed (Windows pipes buffer aggressively; `\n` without flush hangs the GUI/runner waiting for `uciok`/`readyok`/`bestmove`).
- Single-threaded read loop: while searching, `stop`, `isready`, `quit` are not read, so the engine ignores `stop` or `isready` times out and the match runner kills it.
- `\r\n` line endings from the Windows parent leave a trailing `\r` on tokens ("startpos\r"), so command parsing silently fails.
- `setoption name X value Y` parsed with whitespace tokenization: option values with spaces break (and note this repo's path, `D:\TupCode\Chess Engine`, contains a space; any `EvalFile`-style path option must take the rest of the line).
- Castling printed as king-takes-rook (Chess960 style) instead of `e1g1`; promotion piece not lowercase (`e7e8q`); `bestmove` missing after `stop`, or after checkmate/stalemate positions (must print `bestmove 0000` or `(none)` consistently; python-chess tolerates `(none)`/`0000` but your own consumers need to handle it).
- `info` lines with wrong grammar (`score cp` vs `score mate`, `pv` must be last, `lowerbound`/`upperbound` keywords), debug text printed to stdout instead of `info string`/stderr.
- stderr pipe never drained by the parent: if the engine writes logs to stderr and the parent does not read it, the child eventually blocks.
- `position startpos moves ...` replays from scratch each time but the engine keeps stale repetition history; `ucinewgame` does not clear the hash/history.
- Engine does not exit on stdin EOF, so crashed parents leave orphan engine processes at 100% CPU.

**Why it happens:**
UCI looks trivial (a text protocol); the edge cases are all concurrency and I/O.

**How to avoid:**
- Dedicated I/O thread reading stdin; search runs in its own thread; `stop` sets an atomic flag; `isready` answers instantly even during search; strip `\r`.
- Flush after every output line (`std::cout << ... << std::endl` or explicit flush).
- Parse `setoption` as `name <tokens until 'value'> value <rest of line>`.
- Conformance test script driven by python-chess (`chess.engine.SimpleEngine.popen_uci`) that exercises: uciok, isready during search, stop, movetime, depth, nodes, mate positions, `position fen` with en passant, castling, promotions, 1000 consecutive games without hang. Also run a 200-game cutechess/fastchess smoke match (the same tool the gate will use) before the learning loop exists.
- Exit cleanly on EOF and on `quit`.

**Warning signs:**
"Time forfeit" or "stalled connection" in match logs; hangs that disappear when a debugger is attached; games that end after the first move; python-chess `EngineTerminatedError`.

**Phase to address:** Engine core (protocol) + Match harness phase (conformance script and 200-game smoke match as exit criteria).

---

### Pitfall 5: "No clocks" is not "no time management": fixed-depth vs fixed-time vs fixed-nodes chosen carelessly

**What goes wrong:**
v1 has no clocks, but every component still needs a stopping rule, and the wrong one poisons results:
- `go depth N` for matches: depth means different things across engines and positions, so equal depth is not equal strength or equal time. Against Stockfish it is meaningless.
- `go movetime T` for gating matches: results depend on CPU load and thermal state at that moment, so two nets tested at different times are not comparable.
- `go nodes N` for gating: good (reproducible, hardware-independent), but only if node counting is consistent (count in the same place, include qsearch) and the net's NPS cost is accounted for (a bigger net at equal nodes is slower in real time, so gating at equal nodes can promote a net that loses at equal time).
- Search checks the clock/stop only between iterations or every million nodes, so a 1 s movetime takes 3 s on a heavy position; or it checks the clock via an expensive call at every node and loses 20% NPS. Windows default timer resolution (~15.6 ms) makes short `movetime` coarse if `Sleep`-based; use `std::chrono::steady_clock` polled every ~1-4k nodes.
- The first iteration is not guaranteed to complete under tiny budgets, so there is no `bestmove` at all.

**How to avoid:**
- Define explicit modes and where each is used: **fixed nodes** for promotion gating and self-play data generation (reproducible, thermal-proof); **fixed movetime with controlled load** for Stockfish rating runs and human play; **fixed depth** only for post-game review.
- Always complete depth 1 (or return the first legal move) regardless of budget; check the stop condition every ~2048 nodes; subtract a small safety margin from `movetime`.
- Record for every net its NPS and the nodes-equivalent time cost; gate at equal nodes **and** confirm the promoted net at equal time once.

**Warning signs:**
Elo for the same net differs by more than the error bar between a morning and an evening run; promoted net is slower and loses time-based games; `bestmove` occasionally absent.

**Phase to address:** Engine core (stop/limits), Match harness (mode selection), Self-play/gating loop.

---

### Pitfall 6: Lichess labels are misread (perspective, alignment, depth, coverage)

**What goes wrong:**
- Lichess PGN `[%eval ...]` annotations are given from White's perspective and attach to the position **after** the move they follow; training with them as side-to-move scores or off by one ply flips/shifts every label. The net trains fine (loss goes down on the wrong target) and plays erratically.
- `[%eval #N]` mate annotations treated as numbers or dropped inconsistently.
- Only a minority of games in the database carry evals, and those are the games someone requested analysis for (a biased sample), analysed at varying depths and Stockfish versions. Label noise is non-uniform and not documented per game. (Verify the current fraction and annotation format on the exact monthly file you download.)
- Rated bullet/ultrabullet games are full of time-pressure blunders; positions from them are fine as inputs if labelled by search, but result labels from them are nearly noise.

**Why it happens:**
The labels look obviously usable; nobody checks the alignment on a hand-verified game.

**How to avoid:**
- Write a **label alignment test**: take 5 games, hand-check that the eval after 1.e4 e5 is ~0.2 White-POV and that mate-in-N positions carry mate labels at the right ply; assert at ingestion time that mate scores and sign conventions match.
- Convert everything to one convention at ingestion (side-to-move relative, centipawns, mate clamped to e.g. +/-3000 for training) and store that convention in the dataset header.
- Consider **relabelling** a sampled subset with your own engine/Stockfish at a fixed depth. It makes label noise uniform and measurable, and removes dependence on unknown annotation quality. Decide this explicitly in the Bootstrap phase; if Stockfish is used as a labeller, record that in the licensing notes (labels are data, but the decision should be conscious).
- Filter by rating (e.g. both players >= ~2000) and drop ultra-fast time controls for any result-derived label.

**Warning signs:**
Net predicts "Black is winning" in the start position; validation loss improves but equal-node match vs. the classical eval is negative; label histogram is asymmetric between White-to-move and Black-to-move positions.

**Phase to address:** Bootstrap data pipeline.

---

### Pitfall 7: NNUE training data is not cleaned: duplicates, opening positions, checks, tactical noise, leakage

**What goes wrong:**
- **No deduplication / opening overrepresentation.** The first 6-10 plies of millions of games are the same few thousand positions; the net spends capacity memorizing book positions and the loss number looks great because duplicates dominate.
- **Positions in check, and positions where the best/played move is a capture or the eval is tactically unstable**, produce labels that reflect the next ply's tactic rather than the position's static value. Static eval is only meaningful on quiet positions (it is what q-search expects to call it on). Community consensus (Stockfish dataset PRs, nnue-pytorch `smart-fen-skipping`) is to skip in-check positions and positions where the best move is a capture; more aggressive filters (drop positions with only 1-2 good moves) help further. Noisy tactical data demonstrably hurts and can stall convergence ("Study of the Proper NNUE Dataset", arXiv 2412.17948).
- **Extreme scores.** Positions at +/-1500 cp or forced mates dominate the loss in cp space or are saturated in sigmoid space, wasting capacity on already-decided positions.
- **Validation leakage.** Splitting positions randomly puts adjacent positions of the same game in both train and validation, so validation loss is optimistic and overfitting is invisible.
- **Distribution mismatch.** Trained only on human-game positions, then used inside a search that evaluates deep tactical leaf positions that look nothing like club games.

**How to avoid:**
- Skip the first ~8-10 plies (or cap per-position frequency); dedup by Zobrist key (with stm) using a bounded-memory approach (hash set of 64-bit keys on disk or Bloom filter; 16 GB RAM does not hold a billion keys) and cap positions per game (e.g. random 10-20 of ~80).
- Filter: not in check, played/best move not a capture or promotion, `|score|` below a cap (~1000-2000 cp), no forced mate, not insufficient material, ply >= minimum.
- Split train/validation **by game ID** (hash of game ID), never by position. Hold out a fixed validation set and keep it forever (so loss is comparable across training runs).
- Mix in some positions from your own engine's play (quiet leaf/PV positions) once self-play exists.
- Always compare to trivial baselines: predict-the-mean loss and a material-only fit; a net that barely beats them has a pipeline bug, not a capacity problem.

**Warning signs:**
Training loss << validation loss; validation loss that never moves after epoch 1; histogram of plies is spiky at the book depth; top-100 most frequent positions account for a large share of the data.

**Phase to address:** Bootstrap data pipeline (filters + dedup + game-level split are exit criteria). Revisit in Self-play phase for self-play data filters.

---

### Pitfall 8: Wrong or unbalanced label: game result vs. search score

**What goes wrong:**
- Training on game result alone: one noisy bit per game, assigned to ~80 positions; opening positions get labels nearly independent of the position. Net learns material and little else, plateaus early.
- Training on search score alone from the **same** engine and depth that will use the net teaches nothing new (see Pitfall 11).
- Mixing them with an unscaled blend: cp score and {0, 0.5, 1} result are in different spaces. The blend must happen in win-probability (sigmoid) space; `lambda` too high or too low shifts the net toward either noise or self-confirmation.
- Using adjudicated results (resign/draw adjudication) as truth: if adjudication thresholds are loose, wrong results are baked into labels.

**How to avoid:**
- Loss in sigmoid space: `loss = (sigmoid(pred/K) - (lambda * sigmoid(score/K) + (1 - lambda) * result))^2` with `K` fitted on data (Pitfall 3); start around lambda 0.7-1.0 for Lichess/Stockfish-scored data (score is the reliable label); lower lambda only when scores are from weaker search than the game's outcome information.
- For self-play, use deeper-search scores than play-time search (Pitfall 11) and a modest result component (e.g. lambda 0.8-0.9), with result weighted by ply (late positions are closer to the outcome).
- Record lambda, K, filters, and dataset hash in every training run row so any net is reproducible and comparable.
- Only count a result as a label if the game ended by real termination (checkmate, stalemate, 3-fold, 50-move, insufficient material, or a conservative tablebase-style adjudication that you validate).

**Warning signs:**
Net strong in material, weak in positional play; eval mean drifts toward +/-0.5 across all positions; label vs. prediction scatter plot is a flat blob.

**Phase to address:** Bootstrap training; re-decided in Self-play data/training phase.

---

### Pitfall 9: C++ inference disagrees with the PyTorch model (feature mapping, perspective, quantization)

**What goes wrong:**
The exported net "loads and plays" but is not the trained function. Typical causes, in order of frequency:
1. **Feature index mismatch**: piece/square/color ordering, king-bucket mapping, vertical/horizontal mirroring for the Black perspective, differ between the Python data loader and the C++ feature extractor.
2. **Perspective/ordering of accumulators**: concatenating (stm, nstm) in the wrong order at the dense layer input.
3. **Quantization overflow**: int16 feature-transformer accumulators overflow when many features are active or weights drifted outside the representable range; int8 dense weights are not clipped during training so quantization changes the function. (nnue-pytorch clips weights during training to stay inside the quantizable range for this reason.)
4. **Rounding/shift semantics**: Python `//` floors, C++ `/` truncates toward zero, arithmetic shift vs division on negatives; clipped-ReLU range (0..127 vs 0..255) and scale constants differ between trainer and engine.
5. **Incremental accumulator drift**: the incrementally updated accumulator diverges from a from-scratch refresh after capture/promotion/castling/en-passant and king moves, which is invisible in short tests.
6. **SIMD vs scalar mismatch**: AVX2 path has an alignment/saturation bug; the scalar path is right (or vice versa). The Ryzen 9 5900HS supports AVX2 but not AVX-512; do not assume the latter.
7. Endianness and header/layout assumptions in the binary file format (versioning missing so an old net loads silently into a new layout).

**How to avoid:**
- **Parity test as a gate for every export**: dump N (>= 10k) positions with the PyTorch float outputs, the Python-simulated *quantized-integer* outputs, and the C++ outputs; require C++ == integer simulation exactly (bit-exact) and float vs quantized within a stated tolerance (e.g. mean abs error few cp). Fail the export otherwise. This test is cheap and removes the whole class of problem.
- Keep a **scalar reference implementation** in C++ always compiled in and asserted equal to the SIMD path in debug builds.
- Assert incremental accumulators equal refresh at every node in a debug-build perft/self-play walk (include all capture, promotion, castling, en-passant, king-move cases).
- Version the net file: magic number, format version, architecture hash, feature-set id, scale constants (K, output scale), dataset hash.
- Clamp weights during training to the quantizable range; train with clipped ReLU of the exact inference range.
- Bring up the pipeline with a deliberately trivial net first (e.g. 768 inputs -> 64 -> 1 distilled from material eval) and prove parity before the real architecture.

**Warning signs:**
PyTorch validation loss improves but equal-node match shows no gain; eval of start position is not ~0 in C++ while it is in PyTorch; results differ between debug and release builds or between SIMD flags.

**Phase to address:** Net architecture + inference phase (parity test = exit criterion); re-run on every export in the Bootstrap and Self-play phases.

---

### Pitfall 10: Training mechanics: learning rate, sparse input, small-pool overfit

**What goes wrong:**
- **Learning rate too high** causes dead clipped-ReLU units (output stuck at 0 or 1 for all inputs) and a net that outputs a near constant; **too low** wastes the overnight run. Fine-tuning a bootstrapped net at the bootstrap LR immediately wrecks it.
- **Sparse feature input built densely**: HalfKP-style inputs (tens of thousands of features) as dense float tensors or a Python-side loader make the 3060 idle at 5% utilization while one CPU core is pinned. Throughput, not model size, is the bottleneck on a laptop.
- **Starting with the big architecture.** Debugging data, labels, quantization, and training dynamics all at once makes failures impossible to localize.
- **Overfitting small pools**: a self-play pool of a few thousand games is a few hundred thousand positions; a feature transformer with millions of parameters memorizes it. Training loss falls, held-out loss rises, the net gets worse against the previous net.
- No EMA/checkpoint selection: the last checkpoint is not necessarily the best; no early stopping on game-level validation.

**How to avoid:**
- Begin with a simple feature set (e.g. 768 piece-square, or small king-bucketed set) and a small net; scale up only after the end-to-end loop (train -> export -> parity -> match) is proven. The architecture phase should choose the *smallest* thing that makes the loop real.
- Use an `EmbeddingBag`/sparse index representation or a C++/Numba loader producing index tensors; target >70% GPU utilization (check `nvidia-smi`).
- LR schedule with decay (cosine or step), Adam/Ranger-style optimizer; use LR ~10x smaller for fine-tuning; log the fraction of dead units each epoch.
- Held-out game-level validation, early stopping, EMA of weights; train for few epochs over a large pool rather than many epochs over a small one.
- Minimum pool size before a training run is allowed (a configurable guard, not just "when the pool has enough games" in the abstract): derive from number of positions after filtering, not number of games.

**Warning signs:**
All-zero activations, constant output, loss plateau at the "predict the mean" value; GPU utilization low while CPU core saturated; validation loss turning up while training loss falls.

**Phase to address:** Bootstrap training; Self-play training in the learning-loop phase.

---

### Pitfall 11: Self-play produces no new information (collapse to repeated games, same-depth labels)

**What goes wrong:**
- **Determinism**: a deterministic engine (fixed net, fixed nodes, single thread, same opening) plays the exact same game every time. 1,000 "games" are 1 game. The training pool and the gating result are dominated by duplicates.
- **No exploration**: without opening diversification and early-move randomization the data covers a tiny region and the net reinforces its own habits.
- **Same-depth self-labelling**: labelling positions with the net's own search at the depth it will play adds no information beyond the current net; the training target equals the current function, gradient ~ 0 apart from noise.
- **Over-randomization**: temperature too high or random-move probability too high makes games absurd, and labels from them are a distribution the net never faces; engine-vs-engine data gets worse.
- **Endless/drawish games**: repetition loops, no adjudication, shuffling endgames inflate the pool with zero-signal positions and waste hours.
- **Contaminating with gating/rating games** (Pitfall 20).

**How to avoid:**
- Diversify with: (a) a large opening set of balanced positions (from Lichess games after ~8 plies filtered by |eval| < ~100 cp, or random 6-8 ply playouts filtered by quick search), (b) sampling the first K plies (K ~ 8-16) from root moves within a margin of the best (MultiPV or root-move noise) with decaying temperature, (c) occasionally a random legal move at low probability only in the first few plies.
- Report a **unique-game ratio** (distinct move sequences / total) and distinct-position ratio per session; fail the session if the unique ratio is under, say, 95%.
- Label with *deeper* search than play search (e.g. play at nodes N, label at depth/nodes 4-8x N from the same positions) and/or blend with a result component; log the label-search budget. Store both the played move and the label score per position.
- Adjudicate conservatively (resign when |eval| > ~1000 for several consecutive moves; draw when eval ~0 and long quiet play; hard cap ~200 plies), and validate adjudication offline (replay a sample of adjudicated games to full termination and measure agreement).
- Detect repetition/50-move loops and contempt in the search so self-play does not cycle.
- Set expectations honestly (LOW confidence in specific numbers): from a decent Lichess bootstrap, self-play on one laptop typically yields modest, shrinking gains per generation; the bootstrap net quality dominates. The roadmap should not promise a steadily rising curve.

**Warning signs:**
Duplicate games in the PGN; net-vs-previous-net match results of exactly 50.0% for hundreds of games; training loss on new pool far below the validation loss on the held-out set (the pool is too narrow); average game length converging toward the cap.

**Phase to address:** Self-play + learning-loop phase.

---

### Pitfall 12: Catastrophic forgetting and regression when fine-tuning on few games

**What goes wrong:**
Fine-tuning the live net on a small batch of recent games (the project's own and the user's human games) shifts it toward that narrow distribution. It forgets endgames, rarely-seen structures, or tactics the bootstrap covered; the candidate beats the old net in a short gate on the openings it just practised and then collapses elsewhere.

**How to avoid:**
- Never train on "new games only." Train on a **replay window**: a mixture of (a) a fixed anchor sample of the bootstrap dataset (e.g. 30-50%), (b) the last K generations of self-play data, (c) new data. Keep the replay mixture ratios in config and stored with each run.
- Warm-start from the current net with a small LR and few steps; or retrain from the bootstrap weights on the union; compare both once and pick one policy.
- Evaluate candidates on the **frozen** validation set (bootstrap-distribution) *and* on the gate; a candidate whose frozen-validation loss gets materially worse than its parent's is rejected even if the gate passes.
- Weight human games lower than engine games (human results are noisy, a single user supplies very few games); prefer re-scoring human positions with search over using their results.
- Keep every promoted net immutable and retain the last N versions so rollback is a database pointer change.

**Warning signs:**
Frozen-set loss rises generation over generation; candidate wins vs parent but loses to older nets; Stockfish-level score drops while head-to-head with parent rises.

**Phase to address:** Self-play + learning-loop phase (training data mixture policy); Gating phase (frozen-set check).

---

### Pitfall 13: Gating with too few games (the statistics trap)

**What goes wrong:**
With standard-deviation per game of roughly 0.35-0.45 in score for engine games, the Elo error bar is approximately +/-50 Elo (95%) at 100 games, +/-25 at 400, +/-15 at 1000 (approximate; shrinks with higher draw rates and pentanomial pairing). Real net-to-net improvements in a laptop loop are often 5-30 Elo. A 100- or 200-game gate therefore promotes noise about as often as signal, and rejects real small gains. Further:
- Looking at the running score and stopping when it "looks good" inflates false positives (optional stopping); a fixed-N test must stay fixed-N.
- SPRT misconfigured: bounds too wide (needs only huge gains), bounds too narrow (runs forever), alpha/beta too loose, or the H0/H1 convention misread (cutechess/fastchess docs have been described as confusing about which bound is which; verify with a calibration test).
- Trinomial (win/draw/loss) stats on paired-opening games overstate confidence; pentanomial (game-pair) stats are the standard in fishtest-style testing.
- **Winner's curse / multiple testing**: over many candidates, "a rating went up at least once" is guaranteed by noise alone. v1's done criterion ("rating has gone up at least once because of training") is weak as worded.
- Promotion decided on one opening set that candidate training saw (Pitfall 20).

**How to avoid:**
- Use **SPRT with pentanomial/paired statistics** via fastchess or cutechess-cli (do not write your own match runner). Starting point: elo0 = 0, elo1 = 5 to 10, alpha = beta = 0.05, with a hard max-games cap; **if the cap is hit without H1 accepted, do not promote.** Budget the cap against laptop throughput (fixed-node games, 1 thread each, 6-8 concurrent games).
- Mandatory calibration of the gate itself, as a one-time and then a regression test: (1) **A vs A** (same net, different seeds) must almost never pass H1, over e.g. 50 independent runs; (2) **known-better** (same net with 2x nodes, or a deliberately damaged net with noise added to the weights) must pass/fail as expected within the cap. If the gate cannot detect a clear +50 Elo difference, nothing it says is trustworthy.
- Paired openings (each opening played with both colors); a fixed, diverse opening book separate from training openings.
- Redefine the v1 success criterion to something statistical, e.g.: "net N+k is measured >= X Elo above net N with non-overlapping 95% intervals, in an independent re-measurement on fresh opening seeds," not "a number went up."
- Record per promotion: games, W/D/L, pentanomial counts, LLR, bounds, Elo estimate with CI, opening set id, seeds, engine build hash.

**Warning signs:**
Frequent promotions with tiny margins; ratings that zigzag; gate decisions that reverse when re-run; gating wall time much shorter than a few thousand games.

**Phase to address:** Match harness phase (build and calibrate); Gating phase (policy); Rating dashboard (display of CIs).

---

### Pitfall 14: Measuring against a moving target

**What goes wrong:**
- Stockfish binary/version changes (an auto-download of "latest") shift every level's strength; the Elo history gets a step discontinuity unrelated to training.
- Different options between runs (Hash, Threads, Syzygy, Move Overhead, Skill vs UCI_Elo) or different time control.
- Chaining head-to-head gate results ("N+1 beat N by 12, N+2 beat N+1 by 9 ...") and summing them for a headline Elo: self-play Elo inflates, errors accumulate, and the sum is not an external measurement.
- Rating of the earliest net is re-measured with a fresh protocol while later ones used the old one.
- Hardware changes (battery vs plugged in, thermal state) between nets.

**How to avoid:**
- Pin the Stockfish binary (store SHA-256) and the exact option set and the opening book hash in a **protocol version**; every rating row stores protocol version, SF hash, hardware/NPS calibration, TC, thread/hash settings. A new protocol starts a new curve; never splice.
- Headline Elo = performance vs fixed external anchors (Stockfish levels) under one protocol; gate Elo is only for promotion decisions and is not summed.
- Keep a **fixed reference ladder**: the bootstrap net (frozen) and a few older promoted nets are re-played periodically as extra anchors; plot all nets on the same scale via a rating fit (BayesElo/Ordo-style) over all games, not by chaining.
- Log a per-run bench NPS and CPU/GPU temperatures; refuse (or flag) rating runs when NPS deviates >10% from calibration.

**Warning signs:**
A step change in the curve not tied to a promotion; a net's re-measurement differs from its original by more than error bars; headline Elo rising much faster than Stockfish-level performance.

**Phase to address:** Rating phase (protocol versioning), Dashboard.

---

### Pitfall 15: Stockfish `UCI_Elo` / `Skill Level` are not a calibrated ruler (and have a floor and a saturation problem)

**What goes wrong:**
- `UCI_LimitStrength` + `UCI_Elo` is documented as spanning 1320 to 3190, calibrated at a specific long-ish time control (60s+0.6s) and anchored to CCRL 40/4 (Stockfish UCI wiki). At the 0.1-1 s per move you will use on a laptop, the weakening mechanism (which internally maps Elo to a fractional Skill Level, forces multi-PV, and picks sub-optimal moves with randomness; verify against the pinned version's source) behaves differently, and the realized strength does not match the label. Users have reported the CCRL mapping being off by hundreds of Elo at some versions. Treat the labels as ordinal knobs, not as truth.
- `Skill Level` (0-20) is not Elo; UCI_Elo takes precedence over it when LimitStrength is on. Do not use an internet Skill-to-Elo table.
- **Floor**: below 1320 there is no calibrated Stockfish setting. If an early net or buggy engine is worse than the floor it scores ~0% and the match tells you nothing (score near 0% or 100% maps to huge Elo with enormous error).
- **Saturation**: once the engine beats a level 90%+, that level carries almost no information. Elo from a 95-5 score has error bars wider than the effect.
- Stockfish's weakened play is stochastic and, with `Threads > 1` or time-based search, nondeterministic: "same opening" does not mean "same game," but it also does not guarantee diversity.
- The headline number is "Elo on Stockfish's UCI_Elo scale at this protocol," not Lichess/FIDE/chess.com Elo. Label it that way in the dashboard; otherwise the product makes a claim it cannot support.

**How to avoid:**
- Use **UCI_LimitStrength + UCI_Elo only** (not Skill Level) and record the exact version. Choose opponent levels **adaptively** so the expected score is ~30-70%: start with a coarse sweep at ~100 games per level, then concentrate games at the two levels bracketing 50%. Compute performance Elo as opponent_Elo + Elo-from-score with CI, and combine levels via a joint fit.
- Exclude any level where score is outside ~15-85% from the headline fit (record, but do not weight).
- State the scale on the UI ("vs Stockfish UCI_Elo scale, 1 thread, X ms/move") and keep a note that it is not comparable to human rating lists.
- If the engine is below the floor early on, use an engine-internal ladder (e.g., the engine at 1k/10k/100k nodes, or plain material-eval baseline) as anchors, not Stockfish.
- Re-check the mapping once on the pinned version (e.g., two Stockfish levels 200 Elo apart should show ~75% score for the higher one under your protocol) and record the measured spacing; if spacing is compressed or stretched, report measured Elo relative to *that* observed ladder.

**Warning signs:**
Measured Elo of the same net varies >100 between TC settings; two adjacent levels give almost identical results; opponent levels all returning 0% or 100%.

**Phase to address:** Rating phase (opponent selection), Dashboard (labelling).

---

### Pitfall 16: Rating runs with too few games, one opening, and asymmetric resources

**What goes wrong:**
- 20-50 games per level (the temptation because "it's slow") gives +/-100 Elo or worse.
- All games from the start position, or a handful of openings: both engines mostly deterministic, so the sample is a few distinct games repeated; the effective N is tiny and any single opening's quirk decides it.
- Colors not balanced; no paired reversal.
- Hardware/time asymmetry: Stockfish with Threads/Hash different from the engine; Stockfish using its own `Move Overhead`; our engine measured while 12 other jobs run; running 16 concurrent games on 8 physical cores (SMT) halves per-game NPS for both engines but not equally (NNUE with SIMD loses more from SMT contention); the match starts cold and ends thermally throttled so later games had fewer effective nodes, and if net A is tested before net B, the order confounds the result.
- Mixing time controls across the history (0.1s vs 1s vs 5s per move); Elo differences between engines of different NPS are TC-dependent.

**How to avoid:**
- Minimum game counts as policy: >= 400 games per bracketing level for headline ratings (about +/-25 Elo), more for the final reported number; show the CI always. Fewer games are labelled "quick estimate" in the UI.
- A diverse opening book (thousands of balanced positions from Lichess, 6-10 plies, filtered by eval), each used twice with colors swapped; store opening ID per game; count only distinct games and flag duplicates.
- Same options for both engines: Threads = 1, same Hash size, no pondering, no tablebases, Move Overhead set; run <= 6-8 concurrent games (physical cores minus headroom), pin or set priority consistently; no other job running during the rating run (the job scheduler enforces exclusivity).
- Interleave candidates in time (alternate net A and net B blocks), or use fixed-node games for relative comparisons so thermals do not matter.
- One fixed rating TC per protocol version; changing it starts a new protocol.

**Warning signs:**
CI half-width > 40 Elo reported without warning; duplicate game strings in the PGN; NPS logged at the start of a run is >10% above the end.

**Phase to address:** Rating phase.

---

### Pitfall 17: GPU training and CPU self-play contend on one laptop; thermals and power quietly corrupt everything

**What goes wrong:**
- Training data loading is CPU-bound; if self-play (16 threads of search) runs at the same time, the loader starves and the GPU idles, the 6 GB card sits at low utilization, and self-play slows too. Running both "to save time" gets neither done efficiently and makes timing-based measurements meaningless.
- 6 GB VRAM: batch size / model growth causes CUDA OOM mid-run, possibly after hours; display (browser, Windows compositor) shares that memory.
- Sustained all-core load on a laptop CPU triggers thermal/power throttling and, on battery or "balanced" plans, reduced clocks; the GPU in a laptop has a lower sustained power cap. NPS drifts down 10-30% within minutes; time-based matches and anything measured during throttling are biased.
- Windows sleep/hibernate, Windows Update reboots, or lid close kill overnight runs; a crash 6 hours in with no checkpoint loses the night.
- Two Flask processes (debug reloader) or two job runners both start a job.

**How to avoid:**
- **Exclusive job scheduler**: one active heavy job at a time (self-play, training, gating, rating, Lichess ingestion, review), enforced by a DB-backed lock/state machine. The UI shows "busy: X" instead of silently queuing. Human play has priority: pause/reject heavy jobs when a human game is in progress (or cap them to N-2 threads).
- Self-play uses at most `physical cores - 1` workers; engines run at below-normal priority on Windows; reserve cores for the API and data loader during training.
- Use fixed-node search for gating and data generation so throttling affects wall time only, not results; log GPU clocks/temps (`nvidia-smi --query-gpu=temperature.gpu,clocks.sm,power.draw`), CPU bench NPS per batch, and flag throttling.
- Require AC power and a high-performance power plan for long jobs (check at job start; warn in UI); prevent sleep for the process duration (`SetThreadExecutionState`, or `powercfg` guidance); keep a cooling/duty-cycle option for long runs.
- Checkpoint training every N minutes and make every job **resumable and idempotent** (job table with progress; restarting continues, doesn't restart). Mixed precision (bf16/fp16) and gradient accumulation to fit 6 GB; log peak VRAM on a dry run before launching an overnight job.
- Run the Flask/ASGI app with the reloader off for the job-runner process; the job runner is a separate process, not a thread of the web server.

**Warning signs:**
GPU utilization < 50% during training; NPS in logs trending down; "CUDA out of memory" after hours; job log gaps overnight (sleep); two processes holding the same lock.

**Phase to address:** Learning-loop orchestration (scheduler/resumability); Self-play; Training.

---

### Pitfall 18: Disk fills up (decompressed Lichess dumps, binpacks, self-play archives, logs)

**What goes wrong:**
Lichess monthly database files are `.pgn.zst`: tens of GB compressed per recent month, and several times larger when decompressed; decompressing one to disk, or converting everything to a loose per-position format, burns hundreds of GB. Intermediate datasets (filtered, shuffled, relabelled, binpack) multiply that. Self-play archives, per-search `info` logs, TT dumps, old candidate nets and training checkpoints accumulate, and SQLite files with long WAL files grow. The system drive (C:) fills with `%TEMP%` and shuffling scratch files, and then everything (including Windows) breaks.

**How to avoid:**
- Stream: `zstd` decompress -> parse -> filter -> write compact binary; never write the decompressed PGN. Process one monthly file at a time and subsample (a few million games are plenty for a 6 GB laptop-scale net; more data is bounded by training time, not availability).
- Compact formats: store positions as packed boards (~32 bytes) or binpack-style delta-compressed chains (a few bytes per position); never keep per-position FEN text for bulk data.
- Disk budget as config with checks before each job (`shutil.disk_usage`); a retention policy (keep last K candidates/checkpoints, prune old self-play pools after they are merged into the replay window, keep only compact game records not raw `info` logs).
- Put data/scratch/temp on a drive with space and set TMP/TEMP for the job runner; record dataset sizes in the DB and show them in the UI.
- Shuffle strategy that is external-memory (chunked shuffle with random chunk interleaving), not "load all in RAM" (16 GB).

**Warning signs:**
Free space dropping > 5 GB per hour; scratch directories with orphan files after crashed jobs; `.wal` files in the GB range.

**Phase to address:** Bootstrap data pipeline (formats and budgets); Learning-loop orchestration (retention).

---

### Pitfall 19: Windows-specific path, process, and encoding hazards

**What goes wrong:**
- **Path with a space** (`D:\TupCode\Chess Engine`) breaks unquoted shell-string commands, cutechess `cmd=`/`dir=` arguments, and hand-written UCI option parsing. Backslashes in strings and mixed separators in configs.
- **Python text encoding**: `open()` defaults to the locale code page (cp1252 on many Windows setups), so non-ASCII player names (Lichess has plenty) or uploaded PGNs raise `UnicodeDecodeError` or silently mangle; BOM at file start (UTF-8-sig) corrupts the first header tag; Latin-1/Windows-1252 PGNs from older ChessBase files; CRLF vs LF inconsistencies break hash-based dedup of games.
- python-chess `read_game` swallows parse problems into `game.errors`; ingestion that does not check it silently trains on truncated games. Games with `[Variant]`, `[SetUp]/[FEN]`, missing results, comments/NAGs/variations need handling.
- **Locked files**: on Windows a running engine process holding the net file (or an mmap of it) makes overwrite/delete fail with `PermissionError`; promotion implemented as "copy over current.nnue" breaks while a game is running, or worse, a half-written file is loaded.
- **Process cleanup**: killing a parent does not kill children on Windows; orphan engine processes pile up (especially across the Flask debug reloader and page-close events); no `fork`, so gunicorn-style servers aren't available; `multiprocessing` uses spawn (module-level code re-executes; guard with `if __name__ == "__main__"`).
- Antivirus (Defender) real-time scanning of a freshly built engine `.exe` and on each spawn makes 10k-game runs slow and flaky; MAX_PATH (260) limits with deep dataset paths; case-insensitive file names colliding in version tags.
- Building C++: MSVC vs MinGW choice affects `-march` flags, `std::thread` behavior and perf; build flags (`-O3 -march=native` compiled on one machine) aren't portable if the product is later shipped.

**How to avoid:**
- All subprocess calls take an **argument list**, never a shell string; resolve paths with `pathlib`; a single config module for paths; test with the real path containing a space from day one.
- `open(..., encoding="utf-8", errors="replace", newline="")`, use `utf-8-sig` when reading uploads, fall back to latin-1 on decode failure; normalize line endings before hashing; always check `game.errors` and skip/log malformed games; define explicit accept/reject rules for variants/FEN starts.
- Net promotion = write new immutable file `nets/<sha256>.nnue` then update a DB pointer (`current_net`) in a transaction; engines load a specific path at `ucinewgame`/start; old files are deleted only by a retention job when no process references them. Use `os.replace` for atomic pointer files.
- Put engine process management in one module: track PIDs, use Windows Job Objects (or `psutil` tree-kill) so children die with the parent; kill on API shutdown and on idle timeout.
- Add the project directories to Defender exclusions during long runs (documented, optional), or keep engine processes alive across games.
- Pick one toolchain (recommended: MSVC or clang-cl for dev, with a CMake build), pin flags in the build config, test AVX2 and scalar builds.

**Warning signs:**
`UnicodeDecodeError` during ingestion; `WinError 5/32` (access/in-use); `tasklist` shows multiple engine processes after the app is closed; ingestion count of games differs from the file's game count without logged reasons.

**Phase to address:** Cross-cutting from the first phase (project conventions); PGN ingestion phase; Gating/promotion implementation.

---

### Pitfall 20: Train/test contamination (Goodhart): the net learns the test

**What goes wrong:**
Self-play uses the same opening book as gating and rating matches; or Stockfish-match games are folded back into the training pool; or the user plays the same few openings against the engine and those games dominate the pool. The candidate's gate result and the rating then partly measure memorization of the test openings. The Elo curve rises, and the real strength does not.

**How to avoid:**
- Three disjoint opening sets: self-play/training openings, gating openings, rating openings (held out; frozen; hashes in the protocol).
- Rating/gating games are excluded from the training pool by default (tag `purpose` on every game; a training-pool query that filters on it). If those games are later intentionally used, the rating openings must still be held out.
- Cap the share of any single opening or any single source (human, upload, self-play) in the mixed pool.

**Warning signs:**
Gap between head-to-head performance on gating openings and on fresh openings; Stockfish-level performance flat while gate results rise.

**Phase to address:** Learning-loop data model (game purpose tagging); Rating phase (held-out set).

---

### Pitfall 21: "Net changed" mistaken for "net improved" in product and data model

**What goes wrong:**
- A promotion row exists, the dashboard shows the new net id and an arrow, but there is no stored evidence (games, CI, protocol) behind it.
- A manually triggered "train now" followed by an automatic swap, bypassing the gate, or a gate result recorded as pass because the job exited with code 0 even though the match crashed halfway.
- The rating history x-axis is time, not net version, so a rating change caused by a protocol change reads as progress.
- The live net file is replaced while the dashboard still points at the old rating.
- Flaky gate infrastructure (engine crash counts as a loss for one side only; time forfeits) produces asymmetric results.

**How to avoid:**
- Data model: `nets` (immutable, hash, parent, dataset id, hyperparameters, git hash of trainer), `matches` (full stats), `promotions` (net, parent, match id, decision, reason), `rating_runs` (protocol version, per-level W/D/L, fit, CI). A net is "live" only via a promotion row that references a passing match.
- Gate harness verifies integrity: total games = planned, zero crashes/forfeits/illegal moves (or they are reported and the run is invalid), every game has a valid result, unique-game ratio above threshold. Any integrity failure -> "invalid," not "fail" or "pass."
- UI states: "candidate (unverified)", "promoted (evidence: +X [lo, hi], N games)", "rejected". The headline chart plots Elo with CI bars per net version, not just a line.
- The manual "train now" produces a candidate only; it never swaps the live net.

**Warning signs:**
Promotions with null match IDs; match rows with games != planned; rating chart without error bars.

**Phase to address:** Learning-loop data model + gating phase; Dashboard.

---

### Pitfall 22: Live engine output floods the browser; eval bar lies

**What goes wrong:**
- A fast engine emits hundreds of `info` lines per second at shallow depth (depths 1-8 complete in microseconds to milliseconds). Pushing each over SSE/WebSocket and calling `setState` on each causes React re-render storms: the board janks, the tab uses a core, the eval bar flickers.
- Eval bar shows side-to-move-relative scores, so it flips every move; or displays `lowerbound`/`upperbound` partial results as final; or shows mate as a huge number; or jumps wildly at depth < 6.
- Stale updates: a late `info` line for the previous move arrives after `bestmove` and overwrites the current display.
- Multi-tab: two tabs open two streams and two engines.

**How to avoid:**
- Server-side **coalescing**: keep only the latest `info` per depth change or per tick; emit at 4-10 Hz max; send the final line on `bestmove`. Ignore bound-flag lines and depth < ~6 for the bar (show "thinking...").
- Normalize to White's perspective in the backend (single place), convert mate to a structured `{mate: N}` and clamp the bar via a smoothed function of win probability (`1/(1+10^(-cp/400))`), not linear cp.
- Frontend: store the latest info in a ref/store slice and update the DOM at most per animation frame; memoize the board; keep the zustand slice separate from board state (per cookbook rules); tag every message with a `searchId` and drop stale ones.
- One engine session per game id; the second tab attaches to the same stream or is refused.

**Warning signs:**
Browser dev tools show > 30 renders/s for the eval component; CPU usage of the tab > 15% during thinking; bar flips when it's Black's move.

**Phase to address:** Play UI/API phase.

---

### Pitfall 23: Long jobs block the API; SSE starves the server

**What goes wrong:**
- Self-play, training launches, ingestion, review, and rating run inline in request handlers or in threads of the Flask process: the API is unresponsive, the browser times out, the user cannot play while a job runs.
- Flask's built-in server is development-only. With a WSGI server such as waitress (the usual Windows choice), each open SSE stream holds a worker thread; a few open streams or tabs can exhaust the pool and hang all other requests (waitress default thread count is small). Windows has no gunicorn/fork.
- The Axios base URL (port 8000) and Flask (port 5000) in the scaffold already disagree; environment/config are hardcoded.
- Jobs started by an HTTP request die when the server reloads; progress lives only in memory.

**How to avoid:**
- API process only does short work. Jobs run in a **separate worker process** that polls a SQLite `jobs` table (status, progress, heartbeat, params); API returns 202 + job id; frontend polls (or one SSE channel) for progress. Heartbeats let the API detect dead workers.
- For live thinking streams, prefer an ASGI stack (FastAPI/Starlette + uvicorn, WebSocket or SSE) over WSGI threads; if staying with Flask, use a dedicated thread pool sized well above the expected stream count and keep a hard limit of one stream per game. Decide this explicitly in the API phase; the existing Flask hello-world is not an obligation.
- Use SQLite in WAL mode with short transactions and a single writer discipline; set a busy timeout.
- Config via env (per the cookbook rules): the API URL, ports, paths.

**Warning signs:**
`/api/health` slow while a job runs; browser tab count correlates with API hangs; jobs vanish on code reload.

**Phase to address:** API/orchestration phase; Play UI phase.

---

## Moderate Pitfalls

### Pitfall 24: The playing engine is slowed by the user's own jobs, then those weakened games become training data

**What goes wrong:** Human plays while self-play/training runs: the engine gets fewer nodes, plays worse, and its (labelled) moves enter the pool at low quality; or the UI lags.
**Prevention:** Scheduler gives human play priority (Pitfall 17); record `nodes`/`time` actually used per move in the game record; filter out moves searched with budgets under a threshold from label data.

### Pitfall 25: Orphaned engine processes and unbounded engine sessions

**What goes wrong:** Tab closed mid-think, the engine keeps searching (`go infinite`) at 100% CPU forever.
**Prevention:** Session objects with idle timeout and explicit `stop` + `quit`; always use `movetime`/`depth` limits for the web (never `go infinite` without a server-side stop timer); cap concurrent sessions at one human game.

### Pitfall 26: Post-game review labels blunders by raw centipawn loss

**What goes wrong:** Moving from +9.0 to +6.0 is flagged a "blunder"; shallow-depth noise flags good moves as mistakes; analysis blocks the API.
**Prevention:** Classify by win-probability loss (sigmoid of cp), with thresholds (e.g. >10-20 points); analyze at fixed depth/nodes in a background job; cache per game; mark positions in check/forced moves; use the same eval conventions as the live bar.

### Pitfall 27: Human/uploaded games treated as high-value training data

**What goes wrong:** A single user's games are few, low-rated relative to the engine, and the result labels reflect the user's blunders. Uploaded PGNs come from unknown sources with variants, bad FENs, duplicates.
**Prevention:** Ingest as positions to be re-scored by search; dedupe by game hash; cap source share; validate legality; record provenance per game; keep ingestion idempotent.

### Pitfall 28: Hyperparameter and data drift without provenance

**What goes wrong:** No one can say which dataset/filters/lambda/K/seed produced net 7. A regression cannot be bisected.
**Prevention:** Every training run row stores config, dataset hash, git hash, seed, environment (torch/CUDA versions); every net is reproducible from its row; export includes the metadata in the file header.

### Pitfall 29: Premature optimization of search/NNUE before the loop works

**What goes wrong:** Weeks go into SIMD, multi-threading (Lazy SMP), tablebases, and fancy pruning while the learning loop has never run end to end. The project's value is "Elo goes up because of training," not engine ranking.
**Prevention:** Roadmap order: correct engine (classical eval) -> measurement harness -> small net end-to-end with parity -> bootstrap -> loop -> product polish. Single-threaded search is fine for v1 (and simplifies reproducibility and parallel game throughput); defer Lazy SMP.

### Pitfall 30: Over-trusting Stockfish engine strength labels for "play the user" or UI claims

**What goes wrong:** The UI says "Engine is 2400 Elo" based on the UCI_Elo scale; users compare to Lichess ratings.
**Prevention:** Label as "vs Stockfish UCI_Elo scale", explain in a tooltip; v1 does not claim human-comparable ratings.

---

## Minor Pitfalls

### Pitfall 31: Seeds not recorded, so "flaky" results cannot be reproduced
**Prevention:** Seed every RNG (opening picker, temperature sampling, shuffling, init) and store it with the job.

### Pitfall 32: Timestamps and timezones in DB rows
**Prevention:** UTC ISO-8601 everywhere; the UI converts.

### Pitfall 33: PGN output for self-play lacks the info needed later
**Prevention:** Write headers: `Event`, `Round`, `White/Black` (net hashes), `Result`, `Termination`, `Opening ID`, `Nodes`, `Seed`; add `{eval/depth}` comments per move only if needed (they bloat); store the compact record and derive PGN on demand.

### Pitfall 34: Using the user's wall-clock "thinking time" setting for gating
**Prevention:** Gating ignores UI settings; protocol constants are in versioned config.

### Pitfall 35: Not limiting hash size
**Prevention:** With 8 concurrent games, 8 x 256 MB hash is fine, but 8 x 2 GB exhausts 16 GB RAM; cap and clear hash on `ucinewgame`.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Own match runner instead of fastchess/cutechess | Fewer dependencies | Rediscovers adjudication, crash handling, pairing, SPRT math; subtly wrong stats | Never for gating or rating; fine for a 20-game smoke script |
| Overwrite `current.nnue` in place | Simple promotion | File locks on Windows, half-written loads, no rollback, no audit trail | Never |
| Splitting validation set by position | One line of code | Meaningless validation loss; overfitting invisible | Never |
| Fixed-seed, fixed-opening self-play | Reproducible | Duplicate games, no learning signal | Only for debugging a single session |
| Skipping parity test "because nets seem to play fine" | Saves a day | Unfindable disagreement bugs weeks later | Never |
| Gate on 100-200 games | Fast iteration | Noise promotions, random-walk Elo | Only as a *smoke screen* that can reject early, never to promote |
| Flask dev server + threads for jobs | Works in 10 minutes | API blocks, lost jobs on reload | Prototype of the UI only; replace before self-play lands |
| Decompressing the full Lichess dump | Simpler parsing | Hundreds of GB; slow | Never; stream with zstd |
| HalfKA-size architecture on day one | "Like Stockfish" | Cannot localize failures; slow loader; OOM at 6 GB | Only after the small-net loop is proven |
| Storing eval as float in DB without protocol/version | Faster dashboard | Unreadable history after protocol change | Never |
| Treating `Skill Level` as Elo | Quick yardstick | Meaningless numbers on the dashboard | Never |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| python-chess `SimpleEngine` | Using it inside request handlers or from many threads; ignoring `EngineTerminatedError`; not closing engines | One engine object per session owned by one thread/event loop; `engine.quit()` in `finally`; timeout all calls; restart on termination |
| python-chess PGN reader | Ignoring `game.errors`; assuming standard start position | Check errors, handle `[FEN]`/`[Variant]`, reject or log |
| cutechess-cli / fastchess | Passing paths as shell strings; no `-repeat`/paired openings; no `-concurrency` limit; running with hash 1 GB x 16 | Argument lists; paired openings; concurrency = physical cores minus headroom; per-engine `option.Hash`/`Threads=1`; save PGN; parse results from the tool's output/PGN |
| Stockfish | Latest binary auto-downloaded; wrong build for CPU (avx2/bmi2 vs generic); leaving Threads/Hash default; setting both Skill Level and UCI_Elo | Pinned binary + SHA; `x86-64-avx2` (or bmi2) build; explicit Threads=1, Hash; only UCI_LimitStrength + UCI_Elo |
| Lichess database | Downloading the newest huge file only; assuming every game has evals; assuming eval format consistent over years | Start with one mid-size month; stream; test the annotation parse on the specific file; verify license/CC0 notes |
| PyTorch CUDA | Default float32, `DataLoader` workers on Windows (spawn overhead, pickle failures) | AMP/bf16; persistent workers or a C++ loader; `num_workers` tuned, guarded `__main__` |
| SQLite | Writers from API and worker simultaneously without WAL/busy timeout; storing big blobs for games | WAL, busy_timeout, short transactions; games as files with DB index, or compact blobs |
| Zstandard | Python `zstandard` stream reader with default max window mismatched; reading `.zst` with `zstd` CLI missing on Windows | Use `zstandard` Python package with `stream_reader`, set `max_window_size`; unit-test on a 1 MB sample |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Python-side feature extraction per position | GPU < 30%, one core at 100% | Index tensors from C++/Numba loader or pre-featurized binary | > ~1M positions per epoch |
| Dense one-hot feature tensors | OOM / slow | `EmbeddingBag`-style sparse input | Any HalfKP-sized input |
| Hash table cleared each move or not cleared between games | NPS drop, or cross-game leakage | Clear on `ucinewgame`, age entries otherwise | Always |
| `std::endl` on every `info` line at high rates | Slow search | Rate-limit `info` emission in the engine to ~every 100 ms or depth change | Shallow depths with many iterations |
| Running 16 concurrent games on 8 cores | Time-based results distorted | <= physical cores; fixed-node games | Any time-based match |
| Reading whole PGN into RAM | Memory error | Streaming parser | Files > few hundred MB |
| Dedup with Python `set` of all keys | 16 GB RAM exhausted | On-disk sort/uniq or Bloom filter | > ~100M positions |
| Re-analyzing the same game on every page view | Review slow | Cache analysis keyed by game hash + engine/net hash | Second view |
| SSE per client with sync workers | API hang | ASGI or limited streams | 3-5 tabs |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Passing user-supplied FEN/move strings directly into the engine's stdin | UCI command injection (embedded newline -> `setoption name EvalFile value <path>`, `quit`, etc.); crashes or reads arbitrary paths | Validate with python-chess (`Board(fen)`, legal moves), send only the board's own regenerated FEN/move list; reject control characters |
| Uploaded PGN with no size/time limits | Memory/CPU exhaustion; decompression bombs for zipped uploads | Max upload size, streaming parse with game-count cap, timeouts, no archive extraction (or strict) |
| Net/engine path taken from request | Path traversal; arbitrary file load | Net ids only; server maps ids to paths from the DB |
| Job-control endpoints unauthenticated (fine for v1 local) but exposed on `0.0.0.0` | Anyone on LAN can start a 10-hour job or delete nets | Bind to `127.0.0.1` by default; auth planned before any public deployment (v2 note) |
| Arbitrary Stockfish/engine options exposed via API | Setting `SyzygyPath`, `EvalFile`, `Debug Log File` to arbitrary locations | Allow-list options |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Eval bar flips/flickers | Looks broken | White-perspective, smoothed, ignore shallow depths |
| "Elo 2150" without scale/CI/protocol | Misleading claim | "Stockfish-scale Elo 2150 +/- 30 (n=800, protocol v2)" |
| Rating chart with no CI | Noise reads as progress | Error bars, hover with W/D/L, protocol markers |
| Training history that shows candidates as "progress" | Confuses user (who is new to engine internals) | Clear state chips: candidate / promoted / rejected, with plain-language explanations |
| Long jobs with no progress/ETA | User assumes hang, kills it | Progress from job table, ETA based on measured throughput, "busy" banner that explains why play is slower |
| Jargon (SPRT, LLR, NNUE) unexplained | Violates the project's stated need to explain from the ground up | Tooltips/glossary with plain-language definitions |
| Engine moves instantly at shallow depth or takes too long | Feels broken | Min think time + max think time; show "thinking" |
| Allowing "train now" with a tiny pool | Wasted run, regression | Disabled with reason until the pool passes the guard |

## "Looks Done But Isn't" Checklist

- [ ] **Move generator:** Passing start-position perft only; verify Kiwipete and CPW positions 3-6 at depth >= 5 plus random-playout equality vs python-chess.
- [ ] **UCI:** Works in your own script; verify with a 200-game fastchess/cutechess smoke match, `stop` during search, `isready` during search, EOF exit.
- [ ] **Search:** Plays reasonable moves; verify bench node count stable, mate-in-N suite, fixed-node self-test of each feature.
- [ ] **Net export:** Loads and plays; verify bit-exact parity test on >= 10k positions and accumulator==refresh assertions.
- [ ] **Bootstrap training:** Loss decreases; verify game-level held-out loss, comparison against predict-the-mean and material baselines, label alignment test, and an equal-node match against the classical-eval engine.
- [ ] **Self-play:** Produces games; verify unique-game ratio, opening diversity, adjudication validation, label-search depth > play depth.
- [ ] **Gate:** Produces pass/fail; verify A-vs-A false-promotion rate and a known-better detection test, integrity checks, max-game cap = reject.
- [ ] **Promotion:** Live net changes; verify immutable file + DB pointer, rollback works, no overwrite, evidence row exists.
- [ ] **Rating:** Shows a number; verify >= 400 games per bracketing level, adaptive levels with 15-85% scores, CI shown, protocol versioned, SF hash pinned, scale labelled.
- [ ] **"Elo went up" (v1 done):** One higher point on chart; verify non-overlapping CIs on independent re-measurement with held-out openings and the same protocol.
- [ ] **Play UI:** Moves can be made; verify throttled live stream (<= 10 Hz), stale-message drop, closing tab stops the engine, API stays responsive during a job.
- [ ] **PGN ingestion:** Imports a clean sample; verify non-ASCII names, BOM, malformed move text, variants, duplicates, size limits.
- [ ] **Overnight run:** Starts; verify sleep disabled, AC power, checkpoint-resume after kill -9, disk guard, no orphan processes in the morning.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Label alignment wrong (Pitfall 6) | MEDIUM | Fix conversion, regenerate filtered dataset from raw stream (keep raw sample + conversion script), retrain; keep the old net only as a negative control |
| Parity disagreement found late (9) | MEDIUM | Freeze promotions, add the parity test, bisect via per-layer dumps; all nets promoted since the last verified parity must be re-gated |
| Gate found unreliable (13) | MEDIUM | Re-run the last K promotions with the calibrated gate; roll back to the last net that re-validates |
| Duplicate-game self-play pool (11) | LOW-MEDIUM | Dedup by game hash, discard pool or mark it excluded, fix diversity, regenerate |
| Catastrophic forgetting (12) | MEDIUM | Roll back to the previous promoted net (pointer change), retrain with a replay mixture |
| Rating protocol drift (14) | LOW | Start a new protocol version; re-run anchors (bootstrap net and one or two older nets) under the new protocol to link curves |
| Disk full mid-job (18) | LOW-MEDIUM | Jobs resumable from checkpoint; retention job; move scratch to a larger drive |
| Corrupt/locked net file (19) | LOW | Pointer to last known-good hash; verify checksum at load |
| Orphan engine processes (19, 25) | LOW | PID registry kill; Job Object |
| Move-gen bug found in production (1) | HIGH | Fix; all games and pools produced since the bug's introduction are suspect (tag by engine build hash; drop or replay-validate with python-chess) |
| Training data polluted by tactical noise (7) | MEDIUM | Re-filter from raw (cheap if raw is kept compactly), retrain |

## Pitfall-to-Phase Mapping

Suggested phase names are working labels for the roadmapper (the actual roadmap may split or merge them).

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 Move-gen bugs | Engine core | Perft suite + random playout oracle vs python-chess pass |
| 2 TT/search unsoundness | Engine core | Bench signature, mate/tactical suite, deterministic node count |
| 3 Net scale vs search | Net architecture + inference | Fixed-node match net vs classical eval; clamp tests |
| 4 UCI mistakes | Engine core + Match harness | python-chess conformance script, 200-game smoke match |
| 5 Time/stop rules | Engine core + Match harness | Documented modes; stop latency test |
| 6 Lichess label misread | Bootstrap data | Alignment test on hand-checked games |
| 7 Dirty training data | Bootstrap data | Filters, dedup, game-level split present; frequency histogram |
| 8 Label choice | Bootstrap training; Learning loop | Lambda/K stored; ablation of lambda on a small run |
| 9 C++/PyTorch disagreement | Net architecture + inference | Bit-exact parity on every export |
| 10 Training mechanics | Bootstrap training | GPU util, dead-unit metric, predict-mean baseline |
| 11 Self-play collapse | Self-play | Unique-game ratio, deeper-label policy |
| 12 Forgetting | Learning loop | Frozen-set loss check, replay mixture |
| 13 Gating statistics | Match harness (calibration) + Gating | A-vs-A and known-better tests |
| 14 Moving target | Rating | Protocol versioning, pinned SF hash |
| 15 Stockfish Elo semantics | Rating | Measured level spacing, adaptive levels |
| 16 Few games/openings/asymmetry | Rating | Min games policy, opening diversity stats, equal options |
| 17 Laptop contention/thermals | Orchestration | Exclusive scheduler, resume test, NPS logging |
| 18 Disk growth | Bootstrap data + Orchestration | Streaming pipeline, disk guard, retention |
| 19 Windows hazards | All phases (conventions), Ingestion, Promotion | Path-with-space test, encoding test, Job Object test |
| 20 Contamination | Learning loop data model; Rating | Purpose tags; disjoint opening sets |
| 21 Net changed != improved | Gating + Dashboard | Promotion requires match evidence row |
| 22 Live output flood | Play UI | Render-rate profile, stale-drop test |
| 23 Blocking API | API/orchestration | Responsiveness under job load; SSE stream limit |
| 24-30 Moderate | Respective phases | See entries |

## Phase-Specific Research Flags

| Phase Topic | Likely Pitfall | Needs Deeper Phase Research? |
|-------------|----------------|------------------------------|
| Net architecture + inference | Feature set, quantization scheme, SIMD (9, 3, 10) | **Yes** (nnue-pytorch/Stockfish docs for exact scales and layouts) |
| Bootstrap data pipeline | Lichess format, label policy, dedup at scale (6, 7, 18) | **Yes** (current file sizes, annotation coverage, relabelling cost) |
| Match harness + gate | SPRT params, tool choice, calibration (13, 4) | **Yes** (fastchess vs cutechess Windows support, bound semantics) |
| Rating | Stockfish limited-strength behavior at short TC (15, 16) | **Yes** (empirical spacing test on pinned version) |
| Self-play loop | Diversity, label depth, replay mix (11, 12) | Moderate (empirical tuning, few published laptop-scale references) |
| Play UI / API | Streaming, ASGI vs Flask (22, 23) | Standard patterns; decide stack in phase |
| Engine core | Perft, TT, UCI (1, 2, 4, 5) | Standard patterns, well documented (CPW) |

## Sources

- Stockfish UCI & Commands wiki (UCI_Elo range 1320-3190, calibration at 60s+0.6s, anchored to CCRL 40/4; UCI_LimitStrength overrides Skill Level): https://github.com/official-stockfish/Stockfish/wiki/UCI-&-Commands (MEDIUM-HIGH; via search snippet, re-verify on the pinned version)
- TalkChess reports of UCI_Elo mismatch vs CCRL (anecdotal, LOW-MEDIUM): https://www.talkchess.com/viewtopic.php?p=951046
- "Study of the Proper NNUE Dataset", arXiv 2412.17948 (noisy/tactical data damages training): https://arxiv.org/pdf/2412.17948 (MEDIUM)
- Stockfish PRs on training data pre-filtering (skip bestmove captures, single-legal-move positions): https://github.com/official-stockfish/Stockfish/pull/4314, https://github.com/official-stockfish/Stockfish/pull/4465 (MEDIUM)
- TalkChess "Best practices for NNUE training data generation?": https://www.talkchess.com/viewtopic.php?p=965863 (MEDIUM, practitioner)
- variant-nnue-pytorch `--smart-fen-skipping` (skip check / capture best-move positions): https://github.com/ianfab/variant-nnue-pytorch (MEDIUM)
- Chessprogramming wiki, Sequential Probability Ratio Test (SPRT, fastchess example, bounds, paired/pentanomial): https://chessprogramming.org/SPRT (MEDIUM-HIGH)
- vdbergh pentanomial/simul tools (pentanomial stats vs trinomial overconfidence): https://github.com/vdbergh/pentanomial (MEDIUM)
- TalkChess on cutechess-cli SPRT elo0/elo1 semantics (convention ambiguity): https://talkchess.com/viewtopic.php?p=906986 (MEDIUM; hence the calibration requirement)
- Domain knowledge (HIGH where stated as widely established): Chess Programming Wiki perft positions, TT mate-score handling, aspiration windows, UCI specification, nnue-pytorch quantization and weight clipping, Stockfish Skill implementation (MEDIUM; confirm against the pinned source), Windows file-locking and encoding behavior.
- Items marked "verify" (Lichess eval coverage and file sizes, Stockfish limited-strength internals, Elo error-bar figures as approximations) were not independently confirmed from primary sources in this pass and should be checked during the relevant phase research.

---
*Pitfalls research for: self-improving chess engine (C++ alpha-beta + NNUE-style eval, Lichess bootstrap, self-play with gating, single Windows laptop)*
*Researched: 2026-10-12*
