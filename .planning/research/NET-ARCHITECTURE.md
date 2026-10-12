# Evaluation Network Architecture: Deep Dive

**Project:** Chess Engine (C++ alpha-beta search + learned evaluation, own weights)
**Researched:** 2026-10-12
**Mode:** Ecosystem + Comparison (raw material for the "design the network" phase)
**Overall confidence:** MEDIUM-HIGH on architecture and tooling facts (read from primary docs and source today); MEDIUM on throughput numbers (measured on this machine with a synthetic benchmark); LOW on Elo-after-bootstrap ranges (no published data-vs-Elo curve exists; ranges are anchored to one hobby engine's public history).

Confidence tags used below: **[HIGH]** read in an official doc/source today or measured here; **[MED]** consistent secondary sources or reasoned from measured numbers; **[LOW]** single secondary source, forum post, or my own estimate. Estimates are labelled "est."

---

## 0. Decisions at a glance (read this first)

| Question | Recommendation | Confidence |
|---|---|---|
| Net family | NNUE (sparse binary inputs, incremental "accumulator", tiny dense layers, integer math). Nothing else fits "hundreds of thousands of evals/sec on CPU inside alpha-beta". | HIGH |
| First net (prove the pipeline) | **Option L**: `768 -> 256` per perspective, two perspectives, 1 output layer, 8 output buckets. 0.20M parameters. | HIGH |
| Target v1 net | **Option R**: `(768 x 5 king buckets, mirrored) -> 512` per perspective, two perspectives, 1 output layer, 8 output buckets. 1.97M parameters. | MEDIUM |
| Later / stretch | **Option C**: `HalfKAv2_hm (22,528 inputs) -> 1024` per perspective, then `16 -> 32 -> 1`, 8 layer stacks. 23.3M parameters. Only worth it with billions of positions. | MEDIUM |
| Training tool | Own small PyTorch trainer first (project is Python-centric, 6 GB is plenty for these sizes, measured below). Re-evaluate Rust `bullet` if training time becomes the bottleneck. nnue-pytorch is built around Stockfish's own architecture and a Docker/Linux workflow; poor fit for a custom net on Windows. | MEDIUM |
| Bootstrap labels | `lichess_db_eval.jsonl` (416M Stockfish-scored positions, CC0) first; PGN `[%eval]` games second; game result is a weak extra signal only. | HIGH (data facts), MEDIUM (recipe) |
| Gating | SPRT in fastchess, bounds `[0, 10]` Elo at first (about 3k-5k games), `[0, 5]` later; final check at fixed TIME, not fixed nodes. | MEDIUM |
| Policy head | Do not build in v1. Make three cheap commitments now: versioned weights file, store the best move in every training record, keep a shared last hidden layer. | MEDIUM |

**Things found on this machine that affect the design phase [HIGH, measured today]:**
- **Disk:** `D:` (the repo drive) has **20 GB free**; `C:` has 69 GB free. One Lichess monthly PGN is 29 GB compressed. A 400M-position training file is about 13-15 GB. Dataset storage must be budgeted before anything is downloaded.
- **No C++ toolchain on PATH:** no `g++`, `clang`, `cl`, `cmake`. A `Microsoft Visual Studio\2022` folder exists but the C++ workload is unconfirmed. No Rust/cargo (needed for `bullet`). `nvcc` 13.2 is present. `python-chess` is not installed.
- **CPU is Zen 3 (Ryzen 9 5900HS): AVX2 yes, AVX-512 no, VNNI no.** Hand-written inference should target AVX2 (`maddubs`+`madd` path), not the AVX-512/VNNI path most blog posts show.
- **Yardstick ceiling:** Stockfish's `UCI_Elo` only spans **1320-3190** (source: `search.h`, "approximately CCRL Blitz Elo"). A decent 768->256 NNUE engine can plausibly exceed 3190, so the rating dashboard needs a second yardstick (see section 6).

---

## 1. Plain-words primer

**In plain words:** A "net" is a long recipe of multiply-and-add steps with adjustable numbers (called weights) that turns a chess position into one score. Training means nudging those numbers, millions of times, so the scores agree better with trusted answers; running it later is just following the recipe, which is cheap.

Concepts you need, in the order they appear later:

1. **Evaluation function.** Takes a position, returns "who is better and by how much", in centipawns (1 pawn = 100). Alpha-beta search calls it at the leaves of its move tree, millions of times per second. Search strength is roughly *speed x evaluation quality*.
2. **Input features.** The net cannot look at a board picture; we turn the position into a long list of yes/no flags, e.g. "white knight on f3" is flag #N. A board has about 30 flags set out of thousands, so the input is **sparse**.
3. **First layer ("feature transformer").** For every flag that is on, add up a column of numbers. Result: a list (say 256 numbers) describing the position. This is the big, knowledge-rich part of the net.
4. **Accumulator (the "UE" in NNUE = Efficiently Updatable).** After a move only 2-4 flags change, so instead of re-adding 30 columns, keep the running total and subtract the columns of flags that turned off and add those that turned on. Like updating a bank balance with the new transactions instead of re-adding the whole statement. This is the trick that makes NNUE fast.
5. **Small dense layers + clipped ReLU.** After the accumulator, a few tiny layers squash and combine the numbers into one score. "Clipped ReLU" just means: clamp each number into the range 0..1.
6. **Quantization.** Training uses decimals (float32). The engine uses whole numbers (int16/int8) because a CPU can process 16-32 whole numbers per instruction. The trained decimals are scaled and rounded; the engine's output must match PyTorch's within a tiny error.
7. **Perspective / king-relative.** The same piece matters differently depending on where *your king* is. So features are tagged with the king's square, and each side gets its own view of the board.
8. **Output buckets.** Several copies of the last layer; pick one by a cheap rule such as piece count (opening vs endgame), so the final step can specialise.
9. **Label / target.** The "trusted answer" the net is trained to reproduce: either a strong engine's score for that position, the game result, or a mix.
10. **Gating.** A new net only replaces the old one if it wins a statistical match (SPRT) against it.

---

## 2. The NNUE family

**In plain words:** NNUE is the small, CPU-friendly kind of neural net that every top alpha-beta engine uses; variants differ mainly in *which yes/no flags* describe the board. Bigger flag sets know more chess but need more data and memory, so for a new engine the right move is to start small and grow in measured steps.

### 2.1 Feature sets: what each encodes [HIGH; nnue-pytorch `docs/nnue.md`, Stockfish `half_ka_v2_hm.h`]

| Feature set | One flag means | Input size | First-layer params at 256 / 1024 neurons | Notes |
|---|---|---|---|---|
| **"A" / PSQ768** (plain piece-square) | piece type + colour on square (12 x 64) | 768 | 0.20M / 0.79M | Not king-aware. What `bullet`'s `Chess768` and Leorik 3.0 use. Dense matmul is fast for training at this size (section 5). |
| **HalfKP** | (my king square, piece square, piece type **excluding kings**, piece colour) | 64x64x5x2 = **40,960** | 10.5M / 41.9M | Original Stockfish-NNUE set (Aug 2020, SFNNv1). Doc notes the original code carried 64 unused Shogi leftovers. |
| **HalfKA** | as HalfKP but kings are also pieces | 64x768 = 49,152 (derived) | 12.6M / 50.3M | Brother of HalfKP, slightly bigger. |
| **HalfKAv2** | as HalfKA but our king and the enemy king share one slot per square (11 planes, not 12) | 64x704 = 45,056 (derived) | 11.5M / 46.1M | About 8% smaller, same information (doc says "8% less space"). |
| **HalfKAv2_hm** ("half-mirrored") | HalfKAv2 with the board mirrored left-right so my king is always on files e-h | 32x704 = **22,528** (source: `SQUARE_NB * PS_NB / 2`) | 5.8M / 23.1M | Current Stockfish base set since Aug 2021. "Strength difference is hardly measurable" vs unmirrored per the doc, and half the size. Max 32 active flags per perspective. |
| **Full_Threats** (+ PP_3Wide) | "my queen on d1 attacks their knight on h5" pairs; pawn-pair features | 59,808 (source) added on top of HalfKAv2_hm | n/a | Stockfish-only luxury (SFNNv10+, Nov 2025+). 800+ GB of training data in their recipe. Ignore for this project. |

**Why king-relative features at all [HIGH].** How good a piece is depends strongly on where the king is: a knight near my castled king defends, near the enemy king attacks, a pawn shield only matters relative to the king. If the flags are tagged with the king square the first layer can learn separate "king safety" knowledge per king location. Cost: when the king moves, every flag changes, so the accumulator for that side must be **refreshed** (recomputed from scratch, about 30 column additions). Kings move rarely, so the average stays low. Engines also keep a small cache of past accumulators per king bucket ("Finny tables"; Viridithas author's write-up) to make refreshes cheaper [MED].

**Two accumulators, one per side [HIGH].** White's view and Black's view are each kept. At evaluation time the net concatenates "side to move" first and "other side" second. Putting side-to-move first lets the net learn *tempo* (whose turn it is is built in); `bullet`'s docs call white-relative inputs "much worse" than side-to-move-relative.

**Cheap middle ground used by hobby engines: king *buckets* on a small set [MED].** Instead of 64 king squares x pieces, group the king squares into 5-10 buckets (mirrored), giving `768 x 5 = 3,840` inputs. Leorik 3.2 uses exactly "5 input buckets, mirrored, 8 output buckets". `bullet`'s docs explicitly warn beginners: *"You won't have enough data for things like HalfKA/HalfKP at first (or perhaps ever, custom bucket schemes will generally serve better with less data)."* This is the basis of Option R.

### 2.2 The accumulator trick and why CPU inference is fast [HIGH]

Linear first layer = "add up the weight columns of the flags that are on". Make move: subtract columns of flags that vanished, add columns of flags that appeared (quiet move: 1 off + 1 on per side; capture: 2 off + 1 on; castling/en passant a few more). Unmake move: don't undo, just pop the saved accumulator off the search stack (`nnue.md`: "the accumulator is not updated when undoing a move; it is stored on the search stack", so float error cannot build up, and with integers it is exact anyway).

What the rest costs: the accumulator is 256-1024 int16 numbers per side. The "dense" part after it is tiny. Total per evaluation, my est. on a 3 GHz AVX2 core: **Option L ~100-200 cycles; R ~200-400 cycles; C ~500-1,200 cycles** (accumulator update + clipped ReLU + output layer(s)), against a full search node (move generation, hash lookup, move ordering, make/unmake) that costs several hundred cycles on its own. Two optimisations used by serious engines (Viridithas write-up, [MED]): **lazy updates** (only apply pending accumulator changes when an evaluation is actually requested; many nodes never evaluate) and **fused add/sub** of several columns in one pass over memory.

`nnue.md` states the design goal: "million(s) of evaluations per second per thread", only possible in the integer domain. Your stated requirement ("hundreds of thousands of evaluations per second") is therefore easy for all three options; the real question is how much of each node's time the net eats (section 8).

### 2.3 Layer stack: from accumulator to one number [HIGH]

```
flags (sparse) -> [feature transformer: add columns] -> accumulator (N int16 per side)
   -> clipped ReLU (clamp 0..1)  (or "SCReLU": clamp then square)
   -> concat(side-to-move, other-side)  = 2N numbers
   -> dense layer(s) -> ... -> 1 number (centipawns)
```

- **Clipped ReLU (CReLU):** `clamp(x, 0, 1)`; quantised domain `clamp(x, 0, 127)` (Stockfish) or `0..255` (bullet examples).
- **SCReLU (squared CReLU):** clamp then square; used by many `bullet`-trained engines (Leorik 3.1 "adopting SCReLU"). Needs care to avoid int16 overflow (Viridithas write-up). Gains are modest; optional.
- **Pairwise multiplication:** split the accumulator into two halves and multiply them elementwise (`crelu(a) * crelu(b)`); halves the width fed to the next layer; used in `bullet`'s multilayer example and Stockfish-style nets. Optional.
- **Shallow on purpose:** `nnue.md`: "most of the knowledge is stored in the first layer... adding further small layers adds little to accuracy, and may even be harmful if quantization is employed due to error accumulation." `bullet` beginner traps: more than one hidden layer is "usually more beneficial to just increase the size of the first hidden layer (up to at least 1024)"; extra layers "require manual SIMD and well-considered quantisation".

### 2.4 Typical sizes, and the speed/strength trade [HIGH on Stockfish history, LOW on Elo-per-size]

Stockfish's published architecture history (`nnue_architecture_history.md`, read today):

| Net generation | Date | Features | First layer (L1) | Later layers |
|---|---|---|---|---|
| SFNNv1 ("Stockfish 12") | 2020-08 | HalfKP | 256 (x2 perspectives) | 32 -> 32 -> 1 |
| SFNNv3 | 2021-08 | HalfKAv2_hm | (L1 larger; see doc) | |
| SFNNv6 -> v9 | 2023-05 -> 2024-04 | HalfKAv2_hm | 1536 -> 2048 -> 2560 -> **3072** | 8 layer stacks by piece count |
| SFNNv10 | 2025-11 | + Full_Threats | **back down to 1024** | |
| SFNNv16 (Stockfish 19, 2026-09-05) | 2026-07 | + PP_3Wide | 1024 | **L2 = 32, L3 = 32, 8 stacks** (current `nnue_architecture.h`) |

The doc's own warning: "Large networks provide more accurate evaluation, but the speed impact might completely negate the gains in real play." Stockfish has *both* grown and shrunk L1 as features and training improved. There is **no published clean Elo-vs-size curve**; what exists:

- Mantissa author: 2x128 perspective net beat a 256 single-perspective net by ~30 Elo on the same data (fast self-play) [LOW].
- Leorik (public history, CCRL ratings; single developer, `bullet`-trained) [MED]: handcrafted eval 2.5 = 2921 Blitz; **3.0: 768->256, 622M positions -> 3276**; 3.1: 640 hidden + SCReLU, 5.2B positions, trained over 19 from-scratch generations -> 3430; 3.2: mirrored, 5 input + 8 output buckets, 6B positions -> 3496. Each step mixes net and search changes, so only the *shape* is reliable: a small net on <1B positions already delivers most of the jump; the next +200 costs 10x the data and a bigger, bucketed net.
- CPW: "most top engines have accumulators above 1024" [LOW].

**Rule of thumb for this project:** pick the size where *training data volume*, not neuron count, is the binding constraint. With 0.4-1B bootstrap positions that is 256-512 neurons with few inputs.

### 2.5 Output buckets by piece count [HIGH]

`nnue.md`: choose a sub-network ("layer stack") per position with a cheap discriminator; Stockfish uses piece count with 8 buckets: `(piece_count - 1) / 4` (32 pieces -> bucket 7; 2-4 pieces -> bucket 0). Inference cost is zero extra (you just read one set of last-layer weights). Training trick: compute all 8 and gather the right one (batched GPU-friendly because the layers are tiny); `bullet` exposes `.select(output_buckets)` with `MaterialCount::<8>`. Why it helps: a king-and-pawn endgame and a crowded middlegame need different weightings of the same flags. Cheapest well-evidenced upgrade after the base net (bullet's progression example 2).

### 2.6 Quantization and keeping PyTorch and C++ in agreement [HIGH on scheme, MED on test recipe]

Two published schemes, both read today:

| | Stockfish (`nnue.md`) | `bullet` simple example |
|---|---|---|
| Feature transformer weights/bias | int16, float x 127 | int16, float x **QA = 255** |
| Accumulator | int16 | int16 |
| Dense weights | int8, float x **64** (max float weight 127/64 = 1.98, so clamp in training) | int16 here (single layer), float x **QB = 64** |
| Biases | int32 | int16, float x QA*QB |
| Output | scaled so 1.0 = 600 internal units (SF), "eval scale" | `SCALE = 400` |
| Activation | CReLU 0..127 (+ SqrCReLU) | SCReLU, 0..255 |

Mechanics that always apply: if inputs are scaled by `s_A` and weights by `s_W`, a layer's integer output is scaled by `s_A*s_W`; biases scaled by the product; divide by `s_W` before the next activation. The final layer gets an extra output scale `s_O` so centipawns land in the engine's range.

**How to make PyTorch and C++ agree (recommended test plan; the approach is my synthesis of the sources, the pieces are cited):**
1. **Train inside the representable range.** Clamp weights after every optimiser step to `+-(max_int/scale)` (Stockfish: +-1.98 for int8-at-64; `bullet` AdamW clips at +-1.98 by default, +-0.99 with factorisers). Stockfish 19 went further with **Quantization-Aware Training (QAT)**, simulating rounding in the forward pass [HIGH that it exists; no details read].
2. **Overflow proof.** Worst case accumulator = bias + sum of the 32 largest-magnitude weight columns' entries per neuron must fit int16. Check this at export time and fail loudly (`bullet` also refuses to write the quantised file if integer overflow occurs).
3. **Export with `round`, not truncate** (`bullet` defaults to truncate; its docs tell you to add `.round()`).
4. **Three evaluators must agree:** PyTorch float, a plain C++ *float* reference, and the optimised C++ *integer/SIMD* path. Compare on 10-50k random held-out positions; track max and mean absolute difference in centipawns (aim: mean < ~1 cp, max a few cp; thresholds are mine, to be calibrated). Stockfish's own repo ships `cross_check_eval.py` for exactly this job.
5. **Symmetry tests:** `eval(position)` must equal `eval(colour-flipped position)` and the left-right mirrored position (for mirrored sets). The vast majority of real bugs here are in perspective/flip/mirror conventions (the doc spends a full section on flip-vs-rotate).
6. **Versioned weights file** with a header: architecture id, feature-set id, layer sizes, scales, hash. The engine refuses mismatched files. This is also the policy-head hook (section 7).
7. **Keep the integer path deterministic** (no float in the hot path), so two machines give identical nodes-at-fixed-depth.

---

## 3. Alternatives, and why alpha-beta engines converged on NNUE

**In plain words:** You can use other kinds of nets (plain dense, convolutional, transformer) but they all have to start from scratch on every position, which is thousands of times slower than updating an accumulator. Alpha-beta asks "evaluate this one position now" millions of times in sequence, which suits a tiny CPU net and is a terrible fit for a GPU that wants hundreds of positions at once.

| Option | Params (typical) | Cost per evaluation (est.) | Evals/sec per CPU thread (est.) | Verdict for alpha-beta |
|---|---|---|---|---|
| **Plain MLP on 768 piece-square inputs, recomputed each time** | 0.2M-1M | 768x256 = 197k multiply-adds if done densely; ~7.7k adds if you exploit sparsity | ~100k-400k dense; sparsity alone gives ~25x | This *is* NNUE minus the accumulator. NNUE = exploiting sparsity + incremental update + integers. No reason to use the slow form. |
| **Small CNN (Lc0-style residual, e.g. 6 blocks x 64 filters)** | ~0.45M conv weights | each 3x3 conv weight is applied at 64 squares: ~28M multiply-adds (12 convs x 36.9k x 64), ~57 MFLOP | ~300-1,000 (CPU float) | ~1,000-5,000x too slow on CPU; on GPU it needs batching. |
| **Tiny transformer (8 layers, d=128, 64 square-tokens)** | ~1.6M | ~200+ MFLOP incl. attention | ~100-300 | Same problem, worse. |
| **Big transformer (Lc0 BT4: 15 layers, d=1024)** | ~hundreds of M | GPU only; ~2.9 GB fp16 [MED] | thousands/sec/GPU in large batches | Strong, but only because it drives a different search (MCTS with batches). |
| **DeepMind "Grandmaster-level chess without search"** | 270M, trained on ~15B Stockfish-labelled points | GPU | n/a | Lichess blitz ~2895 *with no search*, needs "sufficient model and dataset scale" [MED; paper's own number]. Confirms: scale matters, and this route is out of reach for 6 GB. |
| **NNUE (Option L / R / C)** | 0.2M / 2M / 23M | ~100-1,200 cycles (section 2.2) | **1-10M** | The only one whose cost is dominated by the small incremental update. |

Why the GPU doesn't help alpha-beta [HIGH on logic; est. on numbers]:
- Alpha-beta is **depth-first and sequential**: it needs the score of this leaf *before* deciding the next move to try, so there is no natural batch of independent positions. MCTS (Leela) manufactures batches by exploring many tree paths speculatively with "virtual loss".
- One GPU call has a fixed round-trip (PCIe copy + kernel launch + sync) of roughly 0.2-1 ms (est.), i.e. a ceiling of 1-5k evaluations/sec/thread if done one position at a time. NNUE on CPU does ~1-5M. That is a 1,000x gap before the net's own cost.
- A real data point: Stefan Pohl's hybrid test uses Stockfish ~10M nodes/s (14 threads, Ryzen 6800H) against Lc0 on an RTX 3060 given twice the thinking time to compensate [MED; secondary].
- A policy/value MCTS design (AlphaZero style) is explicitly out of scope in `PROJECT.md`; that decision is consistent with this finding.

Small-net research aside: the Rapfi Gomoku paper (arXiv 2503.13178) reaches the same conclusion from another game: a "Mixnet" with incremental updates, driven by alpha-beta, has inference throughput "orders of magnitude higher than ResNet" for slightly worse raw accuracy, and wins under fixed time [MED].

---

## 4. Training targets and data

**In plain words:** The net needs a "right answer" for every position it studies. The best answers come from a much stronger engine's score for that position; the final game result is a noisy extra hint, and for human games it is very noisy.

### 4.1 The three kinds of target [HIGH on definitions, MED on the blend advice]

1. **Search score (centipawns).** A strong engine's evaluation of the position. Converted to a 0..1 "win probability" with a sigmoid before comparing: `p = sigmoid(cp / scale)`; Stockfish's doc fits `scale = 410` to its own data ("depends on the engine, and maybe even on the data"); `bullet` examples use 400. This squashing is useful: a +9 vs +12 pawn difference no longer matters, which matches real play. **Fit your own scale** (logistic regression of game result on score over your data; 20 lines of Python).
2. **Game result (WDL).** 1 / 0.5 / 0 for the side to move. Unbiased about the true outcome but extremely noisy per position (one result labels ~80 positions, many of which were decided by a blunder 30 moves later).
3. **Blend.** `nnue-pytorch`: `target = lambda * eval_wdl + (1 - lambda) * result` (lambda = weight on the **score**). `bullet`: `target = wdl * result + (1 - wdl) * sigmoid(score/SCALE)` (wdl = weight on the **result**; examples use 0.75 with strong self-play data). **These two conventions are opposite. Do not copy a number between tools.**

Stockfish's own finding: "Datasets with more 'positional' evaluations might be better... Better evaluations don't always give better results, as it's a tradeoff between quality and learnability." And: train first on Stockfish-generated data, *then* retrain on better (Lc0-derived) data; "training solely on the Lc0-derived datasets doesn't produce as good results" [HIGH, nnue-pytorch wiki "Training datasets"].

**Recommendation for the Lichess bootstrap:** score-only for `lichess_db_eval` (it has no game result anyway); for PGN-derived positions use mostly score with a small result weight (`bullet` wdl 0.0-0.3; **my judgement**, because human blitz results are far noisier than engine-self-play results that justify 0.75). Treat the weight as the first hyper-parameter to sweep, measured by SPRT, not validation loss (Stockfish docs: compare validation loss only within identical data and loss settings; "engine matches are needed to assess playing strength").

### 4.2 What the Lichess database actually provides [HIGH; read from database.lichess.org today]

| Dataset | Size | Has evals? | License | Use here |
|---|---|---|---|---|
| **`lichess_db_eval.jsonl.zst`** ("Evaluations") | **416,442,401 positions**, last updated 2026-10-05 | **Yes, all of it**: Stockfish scores, each position with one or more evaluations of different depth/nodes and multiple PVs | CC0 | **Primary bootstrap source.** |
| Standard rated games, per month | e.g. 2026-09: **29.2 GB**, 89.6M games; whole archive 8.22 billion games | **About 6% of games** carry `[%eval]` ("About 6% of the games include Stockfish analysis evaluations") | CC0 | Secondary: ~5.4M evaluated games/month (est. 300-400M positions/month at ~70 plies). Filter on the text `[%eval` before parsing. |
| Puzzles / Broadcasts | small | puzzles no; broadcasts yes | CC0 / CC-BY-SA | Skip (variant data is a different licence). |

**`lichess_db_eval` record shape** (one JSON per line): `fen` (pieces, side, castling, en passant only: **no move counters**), `evals[]` each with `depth`, `knodes`, and `pvs[]` of `{cp | mate, line}`. Lichess's own recommendation: "select the evaluation with the highest depth, and use its first PV." The first move of the PV line is the engine's best move (keep it: needed for filtering and for a future policy head).

**PGN `[%eval X]` comments:** pawn units from White's point of view (`[%eval 2.35]` = +235 cp; `[%eval #-4]` = mated in 4). The comment on a move describes the position *after* that move. Positions can be rebuilt by replaying the moves; `%clk` is also present (ignore).

**Caveats I could not resolve from the page [flag for design phase]:** the depth/node budget of the PGN `[%eval]` analysis (not stated); the depth distribution of the eval database (varies, per the page); and sampling bias. The eval database comes from positions users looked at in the analysis board, so it is likely skewed to openings and popular lines and light on deep endgames and quiet engine-style middlegames (**inference**, not stated by Lichess). Measure the distribution (piece count, ply, |score|) before training.

### 4.3 From raw data to labelled training positions [filters: HIGH from `bullet` example; thresholds MED]

`bullet`'s own example filter (for strong self-play data) is a good starting checklist: keep a position only if `ply >= 16`, side to move **not in check**, `|score| <= 10000`, **the best move is not a capture / promotion** (NNUE is called at quiet leaf positions; noisy positions teach it tactics it never sees). For Lichess data add:
- Drop positions with a forced mate score or `|cp| > ~2000-3000` (sigmoid saturates; they are wasted capacity).
- De-duplicate FENs; down-weight the first 8-10 plies (heavily repeated openings).
- Keep the highest-depth evaluation only.
- A TalkChess experimenter training from Lichess games found that discarding positions where only one or two moves are good (multi-PV check) made the net "less tactical" and "usable" [LOW, forum]. The same effect comes from the quiet-position filter above.
- **Label convention:** store the score **from the side to move's point of view** plus a separate "white-relative" copy, and unit-test the sign. A flipped sign trains a net that is confidently wrong and trains happily.

Storage: `bullet`'s simple record is 32 bytes/position (`ChessBoard`; loses castling/halfmove), Stockfish binpack ~2-3 bytes/position compressed but needs its reader. **Own format recommendation:** 32 bytes of packed squares (64 x 4-bit), `int16` score, `int8` result, `uint16` best move, flags. ~37 bytes -> 400M positions = ~15 GB, which does not fit on `D:` today.

### 4.4 How much data for which strength [LOW; no published curve; anchors only]

| Positions | What it supports | Evidence / reasoning |
|---|---|---|
| **~10M** | PSQ768 -> 64-128 neurons; learns material, piece-square values, some king safety. Good enough to debug the whole pipeline, clearly beaten by tuned handcrafted evals. | est. (about 50 positions per weight at 0.2M weights) |
| **~100M** | PSQ768 -> 256 is well-fed (~500 positions/weight); first real jump over handcrafted. | est.; Leorik 3.0 used 622M for 768->256 [MED] |
| **~400M-1B** | 256-512 neurons with king buckets; this is what Lichess evals + a few PGN months can supply. | `bullet` advice on bucket schemes vs HalfKA at low data [HIGH]; Leorik 3.0 [MED] |
| **~1B-6B** | 640-1024 neurons, 5-10 king buckets, output buckets; Leorik 3.1/3.2 trained on 5.2B / 6B; Elo curve still rising. | Leorik [MED] |
| **100B+ (rescored by Lc0)** | Stockfish 17-19 ("hundreds of billions of positions, all consistently rescored using a strong Leela net"); needed for 22k-60k-input feature sets and 1024+ neurons. | Stockfish 17/19 release notes [HIGH] |

Do not extrapolate from these; the project's own SPRT results decide when to grow the net.

---

## 5. Training on a 6 GB GPU

**In plain words:** These nets are small enough that your 3060's memory is not the limit; the limit is how fast positions can be fed through, which I measured on your machine. A run that would take Stockfish a cluster takes you minutes to hours.

### 5.1 Which trainer [MED; decision for the design phase]

| Tool | Fit for this project | Notes |
|---|---|---|
| **nnue-pytorch** (official-stockfish) | Poor fit | Built around Stockfish's feature sets and layer stacks; C++ sparse data loader (compiled), `.binpack` data, official path is **Docker** (container build "30-60 GB"; native Windows not documented in the README read today). Docs: GPU training "needs at least 16 GB system RAM and **8 GB VRAM, with 8 GB being tight**", which refers to the full Stockfish recipe (threat features, large L1, 800+ GB data), not to small nets. Its `docs/nnue.md` is the best explanation of the maths and **should be read**, but `bullet`'s README warns it "isn't a progression guide" and that copying SF architectures "will likely lose Elo" for beginners. |
| **bullet** (jw1912, Rust) | Best off-the-shelf | Chess-specific NNUE trainer used by many top hobby engines; CUDA/ROCm/Metal; loaders for Stockfish/Monty/Viridithas binpacks and its own 32-byte format; examples from `768->N` up to bucketed multi-layer; AdamW, cosine LR. Needs Rust + CUDA toolkit (`CUDA_PATH`); neither Rust nor a C++ compiler is installed here. Config is Rust code, so the Python orchestrator calls it as an external process. |
| **Own PyTorch trainer** | Recommended first | ~200 lines; `torch 2.9.1+cu130` already works here; export code is yours so the quantisation contract with the C++ engine is fully visible. Measured throughput below is adequate for L/R, borderline for C. Learning-friendly for a user new to ML. |

**Recommendation:** write the PyTorch trainer for Options L and R (the user can follow every line); keep `bullet` as the escape hatch if training time or data loading becomes the bottleneck, and use `nnue.md` as the reference for the maths. Decide at the end of the design phase after the first benchmark on real data.

### 5.2 Measured throughput on this machine [HIGH as measurements; synthetic data, GPU-resident, excludes the data pipeline]

Script: pure PyTorch 2.9.1+cu130, `EmbeddingBag` feature transformer (sparse sum), AdamW, batch 16,384, ~26 active flags per side, 8 output buckets, 40 timed steps on the RTX 3060 Laptop (5.99 GB). Sustained laptop throughput may be 10-30% lower under thermal limits (est.).

| Network (first layer -> later layers) | Params | VRAM peak | Positions/sec | 400M-position pass |
|---|---|---|---|---|
| 768 -> 256 (x2) -> 1 (EmbeddingBag) | 0.20M | 0.16 GB | 1.45M | 4.6 min |
| 768 -> 256 (x2) -> 1 (**dense one-hot matmul, bf16**) | 0.20M | 0.13 GB | **4.35M** | **1.5 min** |
| 768 -> 512 (x2) -> 1 (EmbeddingBag / dense) | 0.40M | 0.27 / 0.17 GB | 0.86M / 3.0M | 7.8 / 2.2 min |
| 768 -> 1024 (x2) -> 1 (EmbeddingBag / dense) | 0.80M | 0.50 / 0.27 GB | 0.39M / 1.6M | 16.9 / 4.2 min |
| (768 x 5 buckets) -> 512 (x2) -> 16 -> 32 -> 1, 8 stacks (EmbeddingBag / dense) | 2.10M | 0.30 / 0.41 GB | 0.71M / 0.89M | 9.4 / 7.5 min |
| HalfKAv2_hm (22,528) -> 256 (x2) -> 16 -> 32 -> 1 | 5.84M | 0.26 GB | 1.05M | 6.4 min |
| HalfKAv2_hm -> 512 (x2) -> 16 -> 32 -> 1 | 11.67M | 0.48 GB | 0.58M | 11.4 min |
| HalfKAv2_hm -> **1024** (x2) -> 16 -> 32 -> 1, 8 stacks | 23.34M | 0.92 GB | 0.27M | 24.6 min |
| HalfKAv2_hm -> 1536 (x2) -> 16 -> 32 -> 1 | 35.0M | 1.35 GB | 0.19M | 35.5 min |

Findings:
- **VRAM is a non-issue**: even the 35M-parameter net peaks at 1.35 GB with batch 16,384. The "8 GB is tight" warning applies to Stockfish's 100M-parameter threat-feature nets and bigger batches, not to anything proposed here.
- **Speed is the real limit** for large sparse sets, because `EmbeddingBag` backward is a slow scatter-add. For small input sizes (<= ~4k) a dense one-hot matmul is **3x faster** (tensor cores); for larger ones use the sparse path. The hand-written CUDA kernels in nnue-pytorch/bullet are likely several times faster than stock PyTorch (est., not measured).
- **The data pipeline must keep up** with 1-4M positions/sec: do feature extraction **on the GPU** from the packed 32-byte board (a vectorised table lookup), ship raw bytes only (about 37 B x 16,384 = 0.6 MB per batch). With 16 GB RAM and a 15 GB file you cannot cache the dataset; pre-shuffle once and read shards sequentially (this is also `bullet`'s documented workflow: convert -> shuffle -> interleave).

### 5.3 Recipe [MED; `bullet` examples read today, adapted]

| Item | Value | Source / note |
|---|---|---|
| Optimiser | AdamW | `bullet` examples ("standard optimiser used in NNUE") |
| Batch size | 16,384 | `bullet` examples; `nnue-pytorch` doc example also 16,384 |
| Learning rate | 1e-3 start, decay to about 1e-3 x 0.3^5 = 2.4e-6 (cosine for long runs, step-by-18-epochs x0.1 in the shortest example) | `bullet` progression examples |
| Training length | `bullet` counts in **superbatches of 100M samples** (16,384 x 6,104): 40 superbatches (4B samples) for the 128-neuron baseline, 320 / 640 / 800 for bucketed/multi-layer. | bullet examples |
| For this project | ~10-20 passes over a 400M-position set (4-8B samples) for L and R; early-stop on validation loss | est.; small nets overfit little at this data-to-parameter ratio |
| Score scale | fit your own; start 400 | `bullet`; `nnue.md` uses 410 |
| Result weight | 0.0 for `lichess_db_eval`; 0.1-0.3 for PGN data (bullet convention) | my judgement |
| Weight clipping | keep within quantisation range every step | `nnue.md`, `bullet` |
| Validation | hold out 1-2% by *game* (not by position) | standard practice |
| Checkpoints | every ~1-2 passes; keep best 3; the engine-match result, not loss, picks the winner | Stockfish wiki |

**Expected wall time (using measured throughput, 10 passes of a 400M-position set, excluding data prep):**

| Option | Throughput | 10 passes of 400M | 10 passes of 1B |
|---|---|---|---|
| L (768->256, dense) | ~4M/s | ~17 min | ~42 min |
| R (768x5 -> 512, ~1 layer, sparse path) | ~0.8-1.1M/s (est. from the 2-layer measurement of 0.71-0.89M/s) | ~1.0-1.4 h | ~2.5-3.5 h |
| C (HalfKAv2_hm -> 1024 -> 16 -> 32 -> 1) | 0.27M/s | ~4.1 h | ~10.3 h (an overnight run) |

So the user's "a day or two on the 3060" bootstrap expectation is conservative for L and R and about right for C at billion-position scale. Initial training time is **not** the project's bottleneck; data volume, labelling, and match testing are.

---

## 6. Reinforcement layer, and gating

**In plain words:** After the bootstrap, the engine plays itself with its current net, strong-engine-style scores and results from those games become new training data, and a new net is trained on a mix of old and new data. A new net replaces the old one only if a statistical match says it is really stronger, so luck cannot sneak a worse net in.

### 6.1 How Leela's and Stockfish's data generation differ [MED]

| | Leela (Lc0) | Stockfish / NNUE ecosystem |
|---|---|---|
| Search used to make data | MCTS with the net's own policy+value ("PUCT"); thousands of games per hour by volunteers | Alpha-beta engine; fixed shallow depth (**depth 9**) or fixed nodes (**5,000 nodes**) |
| What it records per position | Full record: board planes, policy (visit counts over moves), `root_q`, `best_q`, game `result`, `visits`, ... (training format v6; Lc0 wiki) | Position, a score, the played move, the result (binpack) |
| Source of diversity | No opening book; **temperature** on move choice early in the game, plus root noise [MED; forum] | Opening book (`noob_3moves.epd`, DFRC books) plus `random_multi_pv 4`, `random_multi_pv_diff 100`: randomly choose among the top-4 lines within 100 cp [HIGH, wiki script] |
| Scale | 2.5B+ self-play games to mid-2025 [MED, Wikipedia] | 16B positions (last big SF-generated set), now 100B+ **relabelled** by a strong Leela net |
| Key lesson | The net improves by playing against itself, but each generation needs thousands of games | Labels from a *different, stronger* source (Lc0) beat self-generated labels; mixing old and new datasets in a deliberate order works best (nnue-pytorch wiki) |

Relevance: you are the weak side of both stories. The sensible plan is the **Stockfish-style shape**: alpha-beta self-play at fixed nodes with randomised openings, scores from a deeper search of the same engine, results as a small extra.

### 6.2 Self-play recipe for this project [MED; parameters are starting points to tune, not published truths]

- **Search budget:** 5,000-10,000 nodes per move (Stockfish used 5,000-node data). At ~1M nodes/s/thread that is 5-10 ms per move and ~0.6-1.2 s per 120-ply game per thread; with 14 threads, **~12-25 games/s, ~45-90k games/hour, ~6-10M training positions/hour after filters** (est.; assumes a working engine at ~1M nps/thread and 2 threads left for orchestration). On-demand sessions ("target game count") fit.
- **Diversity:** start from a book of balanced openings or play 8-10 random plies and discard if the quick score is outside +-150 cp; optionally copy `random_multi_pv` (choose among top-N moves within X cp for the first moves only).
- **Adjudication:** end the game when |score| > ~1000-1500 for several plies in a row (win), or |score| < ~10 for many plies late (draw), saving ~30% of time. Verify with a no-adjudication sample that adjudicated results are right.
- **Record per position:** FEN/packed board, score (side-to-move), best move, played move, final result, ply. (Best move = future policy-head label.)
- **Do not train on positions in check, captures, or after the game is decided and the score saturates** (same filters as section 4.3).

### 6.3 Fine-tuning without catastrophic forgetting [MED on principles; LOW that anything is NNUE-specific]

"Catastrophic forgetting" = training only on new data makes the net lose what the old data taught (e.g., endgames it no longer sees). Evidence base here is thin: general continual-learning literature (replay of old data is the standard remedy; smaller fine-tuning learning rates preserve pre-trained features) and one TalkChess report that an NNUE fine-tuned on a chess variant lost standard-chess play, plus another that successive NNUE fine-tuning passes give only single-digit Elo each, with shrinking returns [LOW, forums]. Recommended policy:

1. **Default: periodic retrain from scratch on the whole pool.** At Option L/R scale this costs 20 minutes to ~3 hours (section 5.3), so it is affordable. Leorik did exactly this: 19 generations, each trained from zero on the cumulative pool [MED]. No forgetting by construction; no hidden coupling between generations.
2. **Quick turnaround alternative: fine-tune the champion** at a low learning rate (about 10-30% of the original start LR, e.g. 1e-4 to 3e-4), 1-3 passes, on a **mix of at least 50% older data** (Lichess + earlier generations) and new self-play data. Keep a **replay buffer**: new data weighted toward recent generations, old data sub-sampled, nothing deleted from the Lichess base.
3. **Never** fine-tune on a single batch of games, or on only the user's human games. Human games enter the pool as ordinary data, not as a special stream.
4. **Detect forgetting directly:** keep a fixed "regression suite" (endgame positions, positions from the Lichess eval set held out) and a gauntlet of *older* champions in every gating run, so a candidate that beats the latest champion but loses to an older one is caught.

### 6.4 Gating with SPRT (fastchess / cutechess) [MED]

An SPRT ("sequential probability ratio test") plays games until the evidence crosses a threshold, so clear winners and losers finish early. You set: `elo0` (the "no real gain" hypothesis), `elo1` (the gain you care to detect), `alpha` (chance of wrongly accepting a bad net), `beta` (chance of wrongly rejecting a good one). Defaults `alpha = beta = 0.05`. Usage example from Chessprogramming wiki: `-sprt elo0=0 elo1=5 alpha=0.05 beta=0.05` in fastchess. **Verify the model option name and default (logistic vs normalized Elo) with `fastchess --help`; I could not confirm it from the official pages today.**

Stockfish's fishtest bounds, from the Chessprogramming wiki table [MED]: gainers [0, 2] short time control (strongest engine); non-regression [-1.75, 0.25]; for weaker engines the bounds get wider: [0, 3] (top-30), [0, 5] (top-200), [0, 10] (everyone else), because weaker engines gain Elo more easily per change.

**Game counts (my Monte Carlo of a trinomial SPRT, alpha = beta = 0.05, 35% / 55% draws; real tools use pentanomial pairs, which need somewhat fewer games):**

| Bounds | True gain of the candidate | Avg games (35% draws) | Avg games (55% draws) | P(promote), 35% draws |
|---|---|---|---|---|
| [0, 10] | 0 Elo | 4,400 | 3,100 | 0.04 |
| [0, 10] | +5 | 7,600 | 5,200 | 0.50 |
| [0, 10] | +10 | 4,400 | 3,100 | 0.96 |
| [0, 10] | +20 | 1,600 | 1,100 | 1.00 |
| [0, 5] | 0 | 16,900 | 11,000 | 0.04 |
| [0, 5] | +2.5 | 28,200 | 19,900 | 0.48 |
| [0, 5] | +5 | 16,800 | 13,300 | 0.94 |
| [0, 5] | +10 | 6,200 | 4,500 | 1.00 |

At ~15-35 games/s (section 6.2 throughput), 4-5k games is about **3-6 minutes** and 17k games about 10-20 minutes at fixed nodes. So `[0, 10]` as the standard gate and `[0, 5]` for fine comparisons are both affordable. A candidate that is only +3 Elo better will usually not be promoted at `[0, 10]`: the gate is built for clear gains, which is the right bias for a training loop (promote less often, never regress).

**Three gating hazards specific to this project:**
1. **Fixed-nodes matches flatter big nets.** At equal nodes a larger net looks stronger, but it also runs fewer nodes per second. The final promotion test must be **fixed time** (e.g., 1 s + 0.01 s increment or 100 ms/move) so net speed is part of the result. Use fixed nodes for fast early screening only.
2. **Self-play Elo inflates and saturates.** Gains between consecutive nets overstate real strength gains. The dashboard rating must come from the external yardstick.
3. **The yardstick ceiling.** Stockfish `UCI_Elo` covers 1320-3190 and is "approximately" CCRL Blitz (source, `search.h`); the low end uses random weaker moves (Skill levels), which does not play like a human. If the engine reaches ~3000+, the capped-Stockfish ladder compresses. Add a second yardstick: full-strength Stockfish with a **node limit** (e.g., `go nodes 1000 ... 100000`) as a ladder of fixed opponents. Record this as an open requirement for the rating phase.

Always use paired openings with colours swapped, a balanced opening book (e.g., from `official-stockfish/books`), and resolve ties by sample size, not by eyeballing.

---

## 7. Policy-head future-proofing

**In plain words:** A "policy head" is a second output that says which moves look most promising, which an engine can use to try good moves first. You can bolt one on later without redoing the evaluation net if you (a) keep the evaluation weights frozen while you teach the new head, and (b) have saved the right answers (the best move) from day one.

**What it is and what it would buy [MED/LOW]:** For each legal move, a probability that this is the best move. In alpha-beta its natural use is **move ordering** (good ordering is what makes alpha-beta fast: "perfect ordering reduces complexity from exponential to its square root", Rapfi paper). Existing engines already order with captures, killer moves, and history tables, which are free. Evidence that a learned policy adds enough to justify its cost in chess alpha-beta is thin: the one academic result I found (Lines of Action, 2001) reports 20-50% smaller search than the history heuristic [LOW, old, different game]; Rapfi (Gomoku, 2025) runs policy+value inside alpha-beta but that game has no good built-in ordering. I found no top chess alpha-beta engine using a neural policy. This matches `PROJECT.md`'s "deferred" decision.

**How to add it without retraining from scratch [MED; my design, standard transfer-learning practice]:**
1. **Share the trunk.** The policy head reads the same hidden numbers the value output reads (the concatenated accumulators, or the last small hidden layer if there is one). Value path stays bit-identical.
2. **Freeze, then train only the new head.** Load the trained value net, freeze every existing weight, add a head, and train it alone with cross-entropy against the best move. Because value weights do not move, the evaluation Elo is exactly unchanged and gating only has to measure the search benefit of the head. An optional later joint fine-tune can be gated like any other candidate.
3. **Head shape:** "from-square x to-square" = 64 x 64 = 4,096 outputs (promotions need a small extra table), or Lc0's 1,858-move vocabulary. Compute **only the legal moves** at a node: roughly 35 dot products.
4. **Training data:** the position plus the engine's best move. Lichess eval JSON gives it directly (first move of the best PV); PGN data gives the move a human played (weaker label); self-play gives the search's chosen move. **So record `best_move` in every training record from the very first dataset** (section 4.3 format). This is the single most important future-proofing step and costs 2 bytes per position.
5. **File format:** weights file with named, versioned sections (`value_v1`, later `policy_v1`) and a header listing which are present. Old engines ignore unknown sections; new engines refuse files missing a required one.

**Inference cost in alpha-beta (est.):**

| Where the head reads from | Cost per node where it is used | Comment |
|---|---|---|
| Last small hidden layer (e.g., 32-d) | ~35 moves x 32 = ~1,100 multiply-adds, ~40-100 cycles | Negligible; this is why a deep stack helps a policy head, even though a value-only net prefers none. |
| Accumulators directly (Option R: 1024-d concat) | ~35 x 1,024 = ~36k multiply-adds, ~1,500-2,500 cycles | As much as 5-10 evaluations; use only at nodes where ordering pays (PV / expected-cut nodes with depth >= 3-4, root), and cache in the transposition table. |

Practical consequence for the design phase: Option R's single output layer has no small hidden layer to hang a cheap head on. If a policy head is a likely future goal, either (a) accept the 36k-MAC head at selected nodes, or (b) give Option R a small 16-d bottleneck after the accumulator. Option C already has a 16 -> 32 stack.

---

## 8. Recommended options

**In plain words:** Three nets, from "prove the pipeline" to "stretch goal". Start with L to learn the whole loop quickly and cheaply, then move to R as the real first product; C is only for when there are billions of positions and an optimised SIMD engine.

### 8.1 Comparison table

| | **Option L** (smaller / faster) | **Option R** (recommended v1) | **Option C** (larger / stronger) |
|---|---|---|---|
| Shape | `768 -> 256` x2 persp. `-> 1`, 8 output buckets | `(768 x 5 king buckets, mirrored) -> 512` x2 persp. `-> 1`, 8 output buckets | `HalfKAv2_hm (22,528) -> 1024` x2 persp. `-> 16 -> 32 -> 1`, 8 layer stacks |
| Inputs | 768 | 3,840 | 22,528 |
| Activation | CReLU or SCReLU | SCReLU (or CReLU) | CReLU + optional SqrCReLU/pairwise |
| Parameters | **0.20M** (200,968) | **1.97M** (1,974,792) | **23.3M** (measured count 23.34M) |
| Weights file (int16 FT, int8/16 rest) | ~0.4 MB | ~4 MB (fits L2/L3 cache) | ~47 MB (feature rows miss cache; needs lazy updates + Finny-style cache) |
| Accumulator update per quiet move | 4 rows x 512 B | 4 rows x 1 KB (+ refresh when king crosses a bucket) | 4 rows x 2 KB (+ refresh, more frequent) |
| Net cost per eval, 3 GHz AVX2 (est.) | ~100-200 cycles, ~10-15% of node time | ~200-400 cycles, ~20-30% | ~500-1,200 cycles, ~40-60% |
| Estimated search speed, one thread (tuned engine; a first engine will be slower) | **2-4M nodes/s** | **1.2-2.5M nodes/s** | **0.5-1.2M nodes/s** |
| Relative nodes/s vs L | 1.0x | ~0.6x | ~0.3x |
| Training VRAM (measured, batch 16,384, fp32 weights + AdamW) | 0.13-0.16 GB | 0.3-0.4 GB | 0.9 GB |
| Training speed (measured on this 3060) | 4.35M pos/s dense | 0.7-1.1M pos/s | 0.27M pos/s |
| Time for 10 passes of 400M positions | ~17 min | ~1.0-1.4 h | ~4.1 h |
| Data it can use well | 100M-1B | 400M-3B | 3B+ (do not start here) |
| Expected gain over a handcrafted/material eval, with a competent search (LOW) | +250 to +350 Elo | +300 to +450 Elo | +300 to +500 Elo, only with 3B+ positions; at <1B positions expect it to equal or trail R |
| Expected absolute strength after Lichess-only bootstrap (CCRL-Blitz-like scale, LOW) | ~2800-3200 | ~2900-3300 | ~2900-3300 until more data exists |
| Evidence anchor | Leorik 3.0: 768->256, 622M positions, 3276 CCRL Blitz vs 2921 handcrafted (net+search combined +355, ~50 of it search) | Leorik 3.2: (768x5 -> 640)x2 -> 1x8, 6B positions, 3496 | Stockfish's own lineage; `bullet` advice not to start here |
| Main risk | Leaves Elo on the table | Needs king-bucket refresh logic + a bucket layout decision | Data-starved, slow to train and to test, hard SIMD |

Notes on the Elo rows: these are **not** the project's 2000-2500 target scale. Leorik's numbers are CCRL Blitz ratings of a mature engine (pruning, reductions, correction history, tuned time management). Your first search will be weaker, so subtract whatever distance your search is from "mature"; the *net-attributable gain* row is the transferable number. Also, Lichess human ratings are not CCRL ratings. Treat all of this as a hypothesis the first end-to-end SPRT runs will replace.

### 8.2 The recommended path

1. **Milestone 0: Option L as the pipeline proof.** End-to-end: Lichess data -> labels -> train (~20 min) -> export -> C++ inference -> PyTorch-vs-C++ agreement test -> SPRT vs a simple handcrafted eval. If the loop works with a 0.2M-parameter net, every later net is just a config change.
2. **Milestone 1: Option R** trained from scratch on the full bootstrap pool, with king-bucket layout and output buckets chosen together. SPRT against L to confirm the extra complexity is actually worth it.
3. **Later:** grow towards C only if (a) R wins by a clear margin over L, (b) data volume has passed ~2B positions, and (c) a measured test shows the nps loss is smaller than the strength gain **at fixed time**.

### 8.3 Open decisions for the design discussion with the user (each fits one conversation)

1. King-bucket layout for Option R (5 vs 10 buckets, mirrored): the one place where chess knowledge directly shapes the net.
2. Activation: CReLU vs SCReLU (SCReLU costs a bit of speed and int16 care; modest strength gain).
3. Output bucket rule: piece-count (default) vs something else.
4. Score scale and the result weight (fit from data; sweep by SPRT).
5. Trainer: own PyTorch (recommended) vs `bullet` (requires installing Rust + C++ toolchain anyway for the engine).
6. Training file format and where the data lives (disk budget: `D:` 20 GB free).
7. Whether to give R a 16-d bottleneck to prepare for a policy head (section 7).
8. A node-limited full-strength Stockfish ladder as a second rating yardstick.

### 8.4 Phase implications for the roadmap

| Roadmap topic | Implication | Research flag |
|---|---|---|
| Toolchain setup | Install MSVC build tools or MinGW/Clang, CMake, (Rust if `bullet`), Stockfish binary, fastchess, `python-chess`, zstd; free or move disk | Standard; verify Windows builds |
| Data pipeline | Extract `lichess_db_eval` + `[%eval]` PGN months, filter, dedupe, pack to own 37-byte record with `best_move`; shuffle on disk | Needs a small spike: measure eval depth/bias distribution; fast parsing without python-chess for 5M games |
| Net v0 (L) + engine inference | Accumulator + AVX2 inference in C++; weights-file format; agreement test | Standard patterns exist (docs read); needs careful tests, not research |
| Net v1 (R) | King-bucket refresh (and optional cache) | Moderate; `bullet` progression examples are the reference |
| Gating & rating | fastchess SPRT; fixed-time final gate; second yardstick | Flag: confirm fastchess option names; decide opening book |
| RL loop | Self-play generator parameters (nodes, openings, adjudication), replay-mix policy | **Needs experiments, not reading**: no published recipe for this scale |
| Policy head | Deferred; commit to `best_move` records + versioned file now | Deeper research only if/when started |

---

## 9. Glossary

- **Accumulator:** the running first-layer totals (256-1024 numbers per side) updated move by move instead of recomputed.
- **Alpha-beta:** the classical search that skips branches it can prove cannot change the best move.
- **AVX2 / AVX-512 / VNNI:** CPU instruction sets that process 16 / 32 / more small numbers at once. Your Ryzen 5900HS (Zen 3) has AVX2 only.
- **AdamW:** the standard "nudge the weights" optimiser; learning rate sets nudge size.
- **Batch / batch size:** how many positions are processed before one weight update (16,384 here).
- **Binpack / bulletformat:** compact file formats for training positions (Stockfish's compressed one; `bullet`'s 32-byte-per-position one).
- **Bucket (input / output):** a rule that picks one of several weight sets (input: by king location; output: by piece count).
- **Catastrophic forgetting:** a net losing old skills after training only on new data.
- **Centipawn (cp):** 1/100 of a pawn; the evaluation unit.
- **CCRL:** the Computer Chess Rating Lists; its Elo scale is the usual yardstick for engines.
- **Clipped ReLU (CReLU):** clamp a number into 0..1 (or 0..127/255 in integers). **SCReLU:** clamp then square.
- **Epoch / pass:** one full pass over the training set. (nnue-pytorch redefines "epoch" as 100M samples; `bullet` uses a 100M-sample "superbatch".)
- **Factoriser (virtual features):** extra shared weights used only during training so rare king-bucketed features learn faster; merged into the real weights on export.
- **Feature / flag:** one yes/no input, e.g. "white knight on f3".
- **Feature transformer:** the big first layer that turns active flags into the accumulator.
- **Finny table:** a cache of past accumulators per king bucket so a refresh only needs a few corrections.
- **Fixed nodes / fixed time:** match limits by search size vs by clock; fixed nodes hides a net's speed cost.
- **Gating:** requiring a statistical match win before a new net replaces the champion.
- **HalfKP / HalfKA / HalfKAv2 / HalfKAv2_hm:** king-relative feature sets (section 2.1); `_hm` = half-mirrored.
- **Incremental update:** changing only what a move changed.
- **Label / target:** the answer a position is trained to match (score, result, or a blend).
- **Lambda / wdl proportion:** blend weight between score and result; **opposite conventions** in nnue-pytorch (weight on score) and bullet (weight on result).
- **Layer stack:** one of several small output networks, picked per position (often by piece count).
- **Lazy evaluation of the accumulator:** apply pending updates only when an evaluation is requested.
- **MCTS / PUCT:** Leela's tree search that evaluates batches on a GPU; not used here.
- **NNUE:** "Efficiently Updatable Neural Network"; the CPU-friendly net family above.
- **Parameter:** one adjustable number in the net. Option L has 0.2 million.
- **Perspective:** one side's view of the board; NNUE keeps two.
- **Policy head:** an output scoring each legal move; used for move ordering.
- **PV (principal variation):** the best line of play the search found.
- **QAT (quantization-aware training):** simulating integer rounding during training so the exported integer net matches the float one.
- **Quantization:** converting trained decimals to small integers for fast CPU math.
- **Quiet position:** no capture/check pending; what NNUE should be trained and used on.
- **SPRT:** sequential probability ratio test; plays games until the evidence is conclusive. `elo0` / `elo1` / `alpha` / `beta` are its settings.
- **Superbatch:** `bullet`'s unit of 100M training samples (16,384 x 6,104 batches).
- **Tempo:** the advantage of having the move; why side-to-move-first ordering matters.
- **UCI / UCI_Elo:** the engine protocol / the Stockfish option that limits its strength to a target Elo (1320-3190).
- **Validation loss:** training error on held-out data; useful within a run, not a substitute for Elo from matches.
- **WDL:** win/draw/loss (1 / 0.5 / 0); also the sigmoid-squashed score space.

---

## 10. Sources

Primary, read today (2026-10-12):

- nnue-pytorch NNUE documentation (features, accumulator, quantization, loss, layer stacks, HalfKAv2_hm, Full_Threats): https://raw.githubusercontent.com/official-stockfish/nnue-pytorch/master/docs/nnue.md [HIGH]
- nnue-pytorch architecture history (SFNNv1-v17, dates, L1 sizes): https://raw.githubusercontent.com/official-stockfish/nnue-pytorch/master/docs/nnue_architecture_history.md [HIGH]
- nnue-pytorch README, training doc, wiki (hardware, datasets, infrastructure, train.py): https://github.com/official-stockfish/nnue-pytorch , https://raw.githubusercontent.com/official-stockfish/nnue-pytorch/master/docs/training.md , https://github.com/official-stockfish/nnue-pytorch/wiki [HIGH]
- Stockfish source: `nnue_architecture.h` (L1 1024, L2 32, L3 32, 8 stacks), `features/half_ka_v2_hm.h` (22,528; 32 max active), `features/full_threats.h` (59,808), `search.h` (UCI_Elo 1320-3190): https://github.com/official-stockfish/Stockfish/tree/master/src [HIGH]
- Stockfish 19 release notes (SFNNv16, QAT, "hundreds of billions of positions rescored by Leela"): https://stockfishchess.org/blog/2026/stockfish-19/ [HIGH]
- Lichess open database (evals, 6% of games with `[%eval]`, 8.22B games, CC0): https://database.lichess.org/ [HIGH]
- bullet trainer (README, docs 1-basics/2-getting-started/3-data/4-saved-networks, `examples/simple.rs`, `examples/progression/*`): https://github.com/jw1912/bullet [HIGH]
- Leorik README (net/search history, CCRL ratings, positions per net): https://github.com/lithander/Leorik [MED, one developer's claims]
- Viridithas author's NNUE performance write-up (lazy updates, Finny tables, SCReLU SIMD): https://asteri.sm/files/2024-06-01-nnue.html [MED]
- Lc0 technical explanation and training data format versions: https://lczero.org/dev/wiki/technical-explanation-of-leela-chess-zero/ , https://lczero.org/dev/wiki/training-data-format-versions/ [HIGH for formats]
- Rapfi (Mixnet, incremental net + alpha-beta, policy/value heads): https://arxiv.org/html/2503.13178 [MED]
- DeepMind, Grandmaster-Level Chess Without Search: https://arxiv.org/abs/2402.04494 [MED, paper's own results]
- Chessprogramming wiki, NNUE and SPRT pages (fishtest bounds table, fastchess example): https://www.chessprogramming.org/NNUE , https://chessprogramming.org/Sequential_Probability_Ratio_Test [MED]
- Fishtest FAQ (Elo estimates of passed patches are biased): https://github.com/official-stockfish/fishtest/wiki/Fishtest-faq [MED]
- Stefan Pohl NN-vs-SF test (Stockfish ~10M nps on 14 threads, Lc0 on RTX 3060): https://sp-cc.de/nn-vs-sf-testing.htm [MED]
- fastchess: https://github.com/Disservin/fastchess (SPRT option details NOT confirmed; see section 6.4)

Secondary / forum (LOW, used only as pointers):
- TalkChess threads on Lichess-game NNUE training (position filtering), NNUE fine-tuning/forgetting, Lc0 temperature and noise, early nnue-pytorch speed: https://talkchess.com/viewtopic.php?p=933194 , https://talkchess.com/viewtopic.php?p=798350 , https://talkchess.com/viewtopic.php?p=963341 , https://talkchess.com/viewtopic.php?p=873564
- Mantissa v3.3.0 release notes (2x128 vs 256 net): https://github.com/jtheardw/mantissa/releases/tag/v3.3.0
- General continual-learning literature on replay and low learning rates: https://arxiv.org/pdf/1612.00796 , https://arxiv.org/pdf/2604.13627

Measured on this machine (scripts in the session scratchpad, not committed): trainer throughput benchmark (EmbeddingBag and dense paths, 9 configurations), SPRT game-count Monte Carlo, toolchain/disk probes.

## 11. Gaps (honest list)

- No published Elo-versus-training-set-size or Elo-versus-L1-size curve was found. Section 4.4 and the Elo rows in section 8.1 are anchored to one hobby engine's history and are hypotheses. **Phase-specific research: run your own ladder (L then R on 100M / 400M / 1B subsets) and plot SPRT Elo.**
- No measured C++ inference speed: no compiler is installed here. The cycle counts and nodes/sec rows are estimates from operation counts and public engine speeds. **Spike needed once the toolchain exists:** a 50-line AVX2 accumulator + output-layer microbenchmark for L/R/C on the 5900HS.
- Pure-PyTorch training speeds are for the trainer step only; real data-loading overhead is unmeasured.
- Depth/node budget and sampling bias of Lichess `[%eval]` and the eval database are not stated by Lichess; measure on a sample.
- fastchess SPRT option names/defaults and the exact Lc0 self-play parameter defaults (temperature schedule, noise) were not confirmed from primary sources.
- Whether Stockfish's own evaluations may be used as training labels in a future public product (the project forbids shipping Stockfish *weights*; labels from a Lichess CC0 dataset are clean, but labels generated by running Stockfish yourself should get a quick licence check before the public-product phase).
