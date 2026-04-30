# Short Answer Grading Guide

> **Purpose**: This document explains the columns produced by the Cadmus Question Library Tools SHORT Answers sub-tab, the reasoning behind each signal, and how to use them in combination to make grading decisions more efficient and more defensible. It is intended for educators, teaching assistants, and anyone using the export CSV to review or moderate SHORT answer responses at scale.

---

## Table of Contents

- [Why a multi-signal approach](#why-a-multi-signal-approach)
- [The evaluation workflow](#the-evaluation-workflow)
- [Column reference](#column-reference)
  - [Cadmus-sourced columns](#cadmus-sourced-columns)
  - [NLP columns](#nlp-columns)
  - [AI columns](#ai-columns)
- [Reading the signals together](#reading-the-signals-together)
  - [Interpreting NLPJaccard and NLPCoverage together](#interpreting-nlpjaccard-and-nlpcoverage-together)
  - [Detecting low-effort responses](#detecting-low-effort-responses)
  - [Surfacing borderline cases for human review](#surfacing-borderline-cases-for-human-review)
  - [Triangulating NLP, AI, and Cadmus signals](#triangulating-nlp-ai-and-cadmus-signals)
- [Recommended sorting and filtering strategies](#recommended-sorting-and-filtering-strategies)
- [Limitations and caveats](#limitations-and-caveats)

---

## Why a multi-signal approach

Short answer auto-marking is a notoriously difficult problem. A student who writes *"the mitochondria is the powerhouse of the cell"* in response to a question about cellular respiration may be demonstrating genuine recall — or may be reproducing a meme. A student who writes nothing like the model answer may still be expressing a substantively correct response in their own words. Cadmus's built-in similarity scorer catches the easy cases; it struggles with paraphrasing, synonymy, and length variation.

This is because no single scoring signal is sufficient on its own:

- **String similarity** (the Cadmus `AnswerSimilarity` score) is sensitive to surface-level word choice. A response that captures the right concept but uses different vocabulary can score near zero, while a response that copies the question verbatim can score high.
- **NLP metrics** add structural context — they can distinguish between a student who covered the key ideas (high `NLPCoverage`) and one who wrote a lot but said little (high `NLPLengthRatio`, low `NLPJaccard`). They can also flag responses that draw most of their vocabulary from the question itself rather than from the student's own understanding (`NLPEchoScore`).
- **LLM evaluation** adds semantic understanding — the model can recognise correct paraphrasing, partial understanding, and off-topic responses in ways that token-matching cannot. More specifically, the LLM can weigh the *substance* of what was written against the *intent* of the question and the model answer.

The key insight is that these signals are complementary, not redundant. Taken together, they allow a marker to triage a large cohort efficiently — routing obvious cases automatically and reserving human attention for the genuinely ambiguous ones.

---

## The evaluation workflow

A recommended sequence for a cohort of any size:

1. **Load Data** on the Cadmus assessment page to pull all SHORT responses into the extension's page state.
2. **Evaluate (NLP)** — runs instantly, no credentials required. This populates the four NLP columns and gives an immediate structural picture of the cohort.
3. **Evaluate with AI** — sends responses to the configured LLM provider for semantic evaluation. For large cohorts with a free-tier API key (Gemini), the extension paces requests automatically; plan for roughly five seconds per question set.
4. **Export SHORT answers** — downloads the full CSV with all signals included.
5. Open the CSV in your preferred analysis tool (Excel, Python, R) and apply the sorting and filtering strategies described below.

You do not need to run both evaluations. NLP alone is sufficient for an initial triage pass; AI alone is sufficient if you want semantic flags without the word-matching context. Running both gives the richest dataset for moderation.

---

## Column reference

### Cadmus-sourced columns

These columns reflect data pulled directly from the Cadmus Apollo GraphQL cache. They represent the state of the assessment at the time you clicked **Load Data**.

| Column | Description |
|--------|-------------|
| `StudentName` | Student's display name as recorded in Cadmus |
| `StudentID` | Cadmus internal student identifier |
| `StudentEmail` | Student email address |
| `QuestionNo` | Sequence number of the question within the assessment |
| `QuestionID` | Cadmus internal question identifier — stable across assessment versions |
| `QuestionPrompt` | Full text of the question as it appeared to students |
| `ExpectedAnswer` | The model answer configured in the Cadmus question editor |
| `StudentAnswer` | The student's submitted response, as stored in Cadmus |
| `AnswerSimilarity` | Cadmus's own string-similarity score between `StudentAnswer` and `ExpectedAnswer`, rounded to an integer percentage (0–100). The underlying algorithm is a normalised edit-distance variant; it is sensitive to word order and exact phrasing |
| `AutomarkScore` | The score Cadmus's own automarker assigned. For SHORT questions this is typically 0 or the full point value — Cadmus does not natively award partial credit for SHORT answers |
| `QuestionMaxScore` | The total points available for this question, as configured in Cadmus |
| `FieldScore` | The current grade the student is receiving for this response field. This is the score that would appear on student transcripts if you do not intervene. Comparing this against `LLMScore` reveals where the AI disagrees with Cadmus's automarker |
| `FieldOutcomeId` | A unique internal identifier for each student × question × field combination. This is the key used when restoring results from a previously exported CSV — if you upload a partial export, the extension matches rows by this value |

**A note on `AnswerSimilarity` vs `AutomarkScore`**: These two can disagree. Cadmus's automarker may award full marks to a response with low similarity if an alternative correct answer was configured; conversely, it may award zero to a response with high similarity if the phrasing falls just outside the configured match threshold. Both values are worth preserving in the export precisely because their disagreement is itself a signal worth investigating.

---

### NLP columns

These four metrics are computed entirely in the browser using a simple tokenisation step: the response text is lowercased, punctuation is stripped, and words shorter than three characters are removed (to exclude common function words). No API calls are made.

**Important**: all four NLP metrics operate on the *token set* — unique words, not word counts. "The cat sat on the mat" and "cat mat sat" produce the same token set. This is by design: the metrics are measuring conceptual coverage, not verbosity.

---

#### `NLPJaccard`

**What it is**: The Jaccard similarity coefficient between the student answer token set and the model answer token set, expressed as an integer percentage (0–100).

**Formula**: `|intersection| / |union| × 100`

**What it means**: A pure bidirectional overlap measure. A score of 60 means 60% of the combined vocabulary of both responses is shared. Because it penalises both missing model-answer terms and extra student terms equally, it tends to be conservative — a student who uses correct vocabulary but also writes a lot of surrounding text will score lower than their coverage alone would suggest.

**Typical ranges**:
- 0–15: Little or no shared vocabulary. Either the student wrote in very different terms, or the response is off-topic or empty.
- 15–40: Partial overlap. Could indicate paraphrasing, partial understanding, or a response that addresses some but not all key concepts.
- 40–70: Strong overlap. Usually indicates a substantively relevant response.
- 70+: Very high overlap. May indicate a well-targeted response, or may indicate the student reproduced the model answer closely — cross-reference `NLPEchoScore` to distinguish.

**Limitations**: Jaccard does not account for synonymy. A student who writes "glucose is broken down to release energy" when the model answer says "respiration oxidises sugar to produce ATP" can score near zero despite being conceptually correct. This is precisely why the AI evaluation path exists alongside NLP.

---

#### `NLPCoverage`

**What it is**: The fraction of model answer tokens that appear in the student response, expressed as an integer percentage (0–100).

**Formula**: `|student ∩ model| / |model| × 100`

**What it means**: A directional measure — it asks "how much of the model answer did the student cover?" Unlike Jaccard, it does not penalise the student for writing additional content beyond the model answer. A student who writes a long, expansive response that happens to include all of the model answer's key terms will score 100, even if Jaccard is moderate.

**What to watch for**:
- High `NLPCoverage` + moderate `NLPJaccard`: the student wrote more than the model answer — could indicate a thorough response or padding.
- Low `NLPCoverage` + high `NLPJaccard`: the student response is short and closely matches a subset of the model answer — may indicate partial knowledge.
- High `NLPCoverage` + high `NLPEchoScore`: the student covered the model answer terms, but many of those terms also appeared in the question — this could be question-parroting rather than genuine understanding.

**Practical use**: `NLPCoverage` is the most directly useful NLP signal for identifying responses that contain the right substance, regardless of length. Sorting by `NLPCoverage` descending is often the fastest way to separate responses that engage with the key ideas from those that do not.

---

#### `NLPEchoScore`

**What it is**: The fraction of student answer tokens that also appear in the question prompt, expressed as an integer percentage (0–100).

**Formula**: `|student ∩ question| / |student| × 100`

**What it means**: A quality signal, not a similarity signal. It asks "how much of what the student wrote came from the question itself?" A high echo score suggests the student may have padded their response by restating the question rather than answering it. This is a common strategy for students who are uncertain — and it is one that string-similarity metrics and even some LLMs can be fooled by.

**Interpretation**:
- 0–30: The student's vocabulary is largely independent of the question — this is the expected range for a substantive response.
- 30–60: Some question vocabulary is present, which is normal (students often use question terms to frame their answer). Review with `NLPCoverage` to assess whether there is additional substance.
- 60+: A large proportion of the student's words came from the question. Cross-reference `LLMFlag` — the AI is specifically instructed to flag these as `ECHO`.

**Limitations**: `NLPEchoScore` is length-sensitive. A very short response that happens to use one or two question words will score high; a long response will dilute the ratio. It is most reliable when read alongside `NLPLengthRatio`.

---

#### `NLPLengthRatio`

**What it is**: The ratio of student response length to model answer length, in characters, capped at 2.0.

**Formula**: `min(len(student) / len(model), 2.0)`

**What it means**: A rough measure of response effort and proportionality. A ratio of 1.0 means the student wrote roughly the same amount as the model answer; 0.2 means they wrote about a fifth as much; 2.0 (the cap) means they wrote at least twice as much.

**What to watch for**:
- Near 0: Very short responses — likely blank, a single word, or a minimal attempt. The AI evaluator flags these as `SKIP`.
- 0.3–0.7: Shorter than the model answer — may still be correct if the student was concise, but worth checking against `NLPCoverage`.
- 0.7–1.5: Within a reasonable range of the model answer length.
- 1.5–2.0: The student wrote substantially more than the model answer. This is not inherently problematic — the model answer is typically concise — but combined with a low `NLPCoverage` it suggests padding rather than depth.

**Limitations**: Length alone is not a quality signal. Some excellent responses are brief; some poor responses are long. `NLPLengthRatio` is most useful as a filter for finding extreme cases (near-zero for blanks; 2.0 for potentially padded responses) rather than as a ranking criterion.

---

### AI columns

These columns are populated by the **Evaluate with AI** button. The LLM receives the question text, the model answer, the maximum point value, and all student responses for that question in a single batched call. It returns a structured JSON array with one object per student.

---

#### `LLMScore`

The score the LLM recommends for this response, expressed in the question's own point scale (not a 0–1 normalised value). For a two-point question, valid values are 0, 0.5, 1, 1.5, and 2. For a one-point question, valid values are 0, 0.25, 0.5, 0.75, and 1.

The quarter-point step size was chosen deliberately: it is granular enough to express meaningful distinctions (full credit, near-full, partial, minimal, none) without requiring the LLM to make finer discriminations that would be unreliable at this level of context. The LLM is explicitly instructed to use only valid values; responses containing invalid scores are rejected and logged as errors.

`LLMScore` is directly comparable to `FieldScore` — both are in Cadmus's own units. A discrepancy between them (e.g. `FieldScore` = 0, `LLMScore` = 1.5 for a two-point question) is a concrete signal that the Cadmus automarker may have underscored a response that deserves human review.

---

#### `LLMFlag`

A categorical label the LLM assigns alongside the score. Flags are defined in the system prompt and are not inferred — the LLM is given explicit criteria for each.

| Flag | What it signals | Typical `LLMScore` range |
|------|----------------|--------------------------|
| `CORRECT` | Full or near-full understanding demonstrated; response addresses the question substantively in the student's own terms | 75–100% of `QuestionMaxScore` |
| `PARTIAL` | Some relevant substance present but significant gaps remain; key concepts missing or incompletely expressed | 25–50% of `QuestionMaxScore` |
| `INCORRECT` | Response is wrong, off-topic, or does not address what was asked; may contain relevant vocabulary without relevant meaning | 0 |
| `ECHO` | The student reproduced the question wording without adding substantive content — the response restates what was asked rather than answering it | 0 |
| `SKIP` | Response was blank, a single character, or too short to evaluate meaningfully | 0 |
| `ERROR` | The LLM call failed for this response (network error, timeout, or malformed response); no score or justification is available | — |

`LLMFlag` is most useful as a primary filter. Sorting by flag and then by `LLMScore` within each flag category allows a marker to process all `CORRECT` responses rapidly (confirming or overriding the recommended score) before focusing attention on `PARTIAL` and `INCORRECT` cases.

---

#### `LLMJustification`

A brief natural-language rationale — typically one to three sentences — explaining why the LLM assigned the given score and flag. The justification is generated in the same call as the score and flag; it is not a post-hoc rationalisation.

Justifications are most valuable in two scenarios:

1. **Where the LLM disagrees with the automarker**: if `LLMScore` is substantially higher or lower than `FieldScore`, the justification explains what the LLM saw in the response that drove the discrepancy.
2. **For `PARTIAL` responses**: a justification can identify which aspects of the model answer the student addressed and which they missed, providing the marker with a starting point for feedback.

Justifications should be treated as a prompt for human review, not as a final determination. The LLM can misread unusual phrasing, disciplinary jargon, or responses that are correct but expressed in ways the model finds unfamiliar.

---

## Reading the signals together

The real value of the export comes from combining signals. Below are the most useful interpretive patterns.

### Interpreting NLPJaccard and NLPCoverage together

| NLPJaccard | NLPCoverage | Likely interpretation |
|------------|-------------|-----------------------|
| High | High | Strong lexical match — student used the right vocabulary and covered the key concepts. High confidence correct. |
| Low | High | Student covered the model answer concepts but also wrote a great deal of surrounding content — paraphrasing or elaboration. Worth checking `LLMFlag`. |
| High | Low | Student response is short and shares vocabulary with only part of the model answer — may indicate partial knowledge or selective recall. |
| Low | Low | Little shared vocabulary in either direction — either a very different conceptual framing (potentially correct) or an off-topic response. `LLMJustification` is most useful here. |

### Detecting low-effort responses

Combine three signals to identify likely minimal-effort or copied responses:

- `NLPLengthRatio` near 0 → blank or near-blank
- `NLPEchoScore` above 60 + `NLPCoverage` below 20 → question restated without substance
- `LLMFlag` = `ECHO` or `SKIP` → AI independently reached the same conclusion

When all three agree, human review can be expedited: these responses are very unlikely to deserve partial credit.

### Surfacing borderline cases for human review

The cases that most benefit from human attention are those where signals diverge:

- `AnswerSimilarity` near 0 but `LLMFlag` = `CORRECT`: the student paraphrased correctly; Cadmus may have underscored
- `AnswerSimilarity` high but `NLPEchoScore` high and `LLMFlag` = `ECHO`: the student copied phrasing from the model answer without demonstrating understanding
- `LLMFlag` = `PARTIAL` with `NLPCoverage` above 60: the student covered the vocabulary but the LLM found the argument incomplete — review `LLMJustification` for what was missing
- `LLMScore` substantially higher than `AutomarkScore`: the AI thinks the student deserves credit Cadmus did not award — a common case when the student paraphrased correctly

### Triangulating NLP, AI, and Cadmus signals

No single column should be used in isolation for consequential grading decisions. The intended workflow is triangulation:

1. **NLP signals** provide the first structural triage — fast, objective, and consistent. Use them to sort the cohort into rough bands.
2. **AI flags and scores** provide semantic context — use them to re-rank within bands and to surface discrepancies with Cadmus.
3. **Human review** focuses on the discrepant cases — where the signals disagree with each other or with Cadmus, and on all `PARTIAL` cases where the justification suggests the marker should make a judgment call.

This approach points to a meaningful reduction in the time required to review large cohorts: responses that are CORRECT by all three signals (NLP high, LLMFlag = CORRECT, AutomarkScore = full) can often be confirmed in bulk; responses that are SKIP or ECHO by all three signals can often be rejected in bulk; only the genuinely ambiguous middle cases require individual attention.

---

## Recommended sorting and filtering strategies

The following Excel or spreadsheet operations are particularly useful on the exported CSV:

**Initial triage sort**: Sort by `LLMFlag` (ascending), then by `LLMScore` descending within each flag. This groups all CORRECT responses first, PARTIAL next, then INCORRECT, ECHO, and SKIP — allowing a marker to move through the cohort in a roughly decreasing order of effort required.

**Discrepancy filter**: Filter for rows where `abs(LLMScore - FieldScore) > 0.25 * QuestionMaxScore`. These are the responses where the AI disagrees meaningfully with Cadmus — the cases most likely to benefit from human review.

**Low-effort filter**: Filter for `NLPLengthRatio < 0.15` OR `LLMFlag` = `SKIP`. These are likely blank or near-blank responses.

**Echo filter**: Filter for `NLPEchoScore > 60` AND `LLMFlag` = `ECHO`. These are likely question-restatements.

**Paraphrasing candidates**: Filter for `AnswerSimilarity < 30` AND `LLMFlag` = `CORRECT`. These are responses the Cadmus automarker likely underscored but which the AI considers substantively correct.

---

## Limitations and caveats

It should be noted that this tool supports, but does not replace, human judgment. Several limitations bear explicit mention:

**NLP limitations**: The tokenisation step removes words shorter than three characters, which means short but meaningful terms (e.g. disciplinary abbreviations, two-letter symbols in science questions) may be excluded. The metrics also assume that the model answer is a reasonably complete and representative sample of the correct vocabulary — if the configured model answer is very sparse or uses unusual phrasing, all NLP scores will be depressed even for correct responses.

**LLM limitations**: The AI evaluator can misread disciplinary jargon, informal but correct expressions, and responses in languages other than the language of the model answer. It is also sensitive to model answer quality — if the model answer is ambiguous or incomplete, the LLM's assessment of student responses against it may be unreliable. The LLM does not have access to any rubric beyond the model answer and the question text.

**Rate limits**: Free-tier API access (particularly Gemini) imposes strict per-minute and per-day limits. For large cohorts the evaluation may take considerable time; the stop-and-resume feature exists precisely to manage this constraint.

**API stability**: The Claude session path (tab injection into an open claude.ai tab) uses internal API structures that may change without notice. If this path stops working, switching to a direct API key in Settings is the reliable alternative.

**Consequential use**: The scores and flags in this export are intended as decision-support signals for human markers, not as final grades. Any score used for consequential purposes (progression decisions, grade submission) should be confirmed by a human reviewer. This is especially true for `PARTIAL` cases, where the LLM justification should be read carefully before accepting or rejecting the suggested score.

---

*This document is maintained alongside the extension source. If the column set or evaluation logic changes, the relevant sections should be updated to reflect current behaviour.*
