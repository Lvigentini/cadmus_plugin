# Assessment Item Design Rationale

> **Purpose**: This document explains the research-informed defaults used by the Cadmus Question Library Tools import system and its companion [AI prompt templates](ai-prompts/). It is intended for question authors, instructional designers, and anyone configuring or extending the import pipeline — whether manually or via the [agentic workflow](ai-prompts/agentic-pipeline.md).

---

## Table of Contents

- [Why defaults matter](#why-defaults-matter)
- [Multiple Choice (MCQ)](#multiple-choice-mcq)
  - [Three options as the default](#three-options-as-the-default)
  - [Distractor quality over quantity](#distractor-quality-over-quantity)
  - [Stem and option guidelines](#stem-and-option-guidelines)
- [Fill in the Blank (FIB)](#fill-in-the-blank-fib)
  - [Cloze-based assessment](#cloze-based-assessment)
  - [Automatic distractor generation](#automatic-distractor-generation)
- [Matching](#matching)
  - [Optimal pair count](#optimal-pair-count)
  - [Unequal premises and responses](#unequal-premises-and-responses)
- [Short Answer](#short-answer)
  - [Constructed response and auto-marking](#constructed-response-and-auto-marking)
- [Bloom's Taxonomy alignment](#blooms-taxonomy-alignment)
- [Difficulty calibration](#difficulty-calibration)
- [Number of questions](#number-of-questions)
- [References](#references)

---

## Why defaults matter

Assessment design is, at its core, a pedagogical act. The defaults embedded in an import tool or a generative prompt shape the items that reach students — and poorly chosen defaults can quietly erode the psychometric quality of an entire question bank. The settings documented here are grounded in decades of educational measurement research and reflect a deliberate effort to align technical convenience with sound assessment practice.

---

## Multiple Choice (MCQ)

### Three options as the default

The extension's AI prompt templates default to **three options** (one correct answer and two distractors) for MCQ items. This may seem counterintuitive — many educators and item-writing guides have traditionally recommended four or five options — but the empirical evidence is clear.

Rodriguez (2005) conducted a meta-analysis spanning 80 years of research on the optimal number of MCQ options and concluded that three-option items perform as well as four- or five-option items on every psychometric dimension that matters: **item difficulty, item discrimination, and test score reliability**. More specifically, reducing from five or four options to three had negligible average effects on these indicators. This finding is consistent with earlier and subsequent work by Haladyna, Downing, and Rodriguez (2002), who validated a taxonomy of 31 item-writing guidelines and noted that "three options are sufficient in most instances and that the effort of developing the fourth option is probably not worth it."

The practical implication is significant: when item writers are forced to produce four or five options, the additional distractors are frequently implausible fillers that no knowledgeable student would select. Haladyna and Downing (1993) examined distractor functionality across hundreds of items and found that only a small fraction (1–8%) had three genuinely functioning distractors. Non-functional distractors add noise, waste testing time, and create a false sense of rigour.

Three-option items also yield a secondary benefit: because each item takes less time to read, **more items can be administered per testing session**, improving content coverage and — by extension — content validity.

The prompts instruct generative models to use four options only when the user explicitly requests it or when the subject matter naturally supports a fourth plausible distractor.

### Distractor quality over quantity

The research consensus is unambiguous: **distractor quality matters far more than distractor quantity** (Haladyna et al., 2002; Gierl, Bulut, Guo, & Zhang, 2017). Effective distractors should:

- Reflect **common student misconceptions** or typical errors
- Be **homogeneous** in length, grammatical structure, and specificity with the correct answer
- Avoid absolute terms ("always", "never") that signal incorrectness
- Avoid "all of the above" and "none of the above" — these are widely discouraged by measurement specialists as they alter the cognitive demand of the item unpredictably

The AI prompt templates and the Quality Reviewer agent in the [agentic pipeline](ai-prompts/agentic-pipeline.md) enforce these guidelines by explicitly flagging implausible or formulaic distractors during the review cycle.

### Stem and option guidelines

Following Haladyna et al. (2002), all prompt templates require that:

- Stems present a **single, clearly formulated problem** — the student should be able to answer before reading the options
- Options are **brief and parallel** in construction
- Negative phrasing is avoided, and where unavoidable, the negative word is emphasised (e.g. "Which of the following is **NOT**…")

---

## Fill in the Blank (FIB)

### Cloze-based assessment

Fill-in-the-blank items in the Cadmus format function as a variant of the **cloze procedure** — a well-established assessment technique with strong empirical support. Meta-analytic evidence has shown correlations of *r* = .54 with crystallised intelligence and *r* = .61 with general intelligence across large samples (Gellert & Elbro, 2025), confirming that cloze-type items can tap meaningful cognitive processes when blanks target key conceptual terms rather than trivial words.

The extension's FIB parser supports multiple blanks per item (`___1___`, `___2___`) and accepts semicolon-separated synonyms as correct answers, which mitigates the well-documented scoring sensitivity of cloze items to minor wording variations (Kleijn, Pander Maat, & Sanders, 2019).

### Automatic distractor generation

The import system automatically generates **two distractors per blank** by cross-pollinating answers from other FIB items in the same file. This approach serves two purposes:

1. Distractors are **content-relevant** — they come from the same domain and difficulty band, making them plausible
2. It reduces the authoring burden, particularly for AI-generated banks where dozens of FIB items may be produced in a single batch

The algorithm prefers answers from the **same blank position** in other items, falling back to any blank position if needed, and applies case-insensitive deduplication to avoid repetition.

---

## Matching

### Optimal pair count

The prompt templates default to **4–6 pairs** per matching item. This range balances two competing concerns:

- **Too few pairs** (2–3) reduce the item to a guessing exercise, since process-of-elimination strategies become trivially effective
- **Too many pairs** (8+) shift the cognitive demand from content knowledge to visual search and working memory load, introducing construct-irrelevant variance (Haladyna, 2004)

The 4–6 range keeps the matching task authentic — testing whether students can associate related concepts — without overwhelming working memory.

### Unequal premises and responses

Item-writing best practice recommends including **more responses than premises**, or allowing responses to be used more than once (Haladyna, 2004). This is because a strict one-to-one mapping allows students to use process of elimination on the final pair, artificially inflating scores. The Cadmus matching format supports this pattern, and the Quality Reviewer agent in the agentic pipeline flags items where the premise and response lists are equal in length.

---

## Short Answer

### Constructed response and auto-marking

Short answer items are **constructed-response** assessments — students produce an answer rather than selecting one. Research consistently shows that constructed-response formats assess higher cognitive levels more authentically than selected-response formats, though at the cost of lower scoring reliability due to rater variability (Martinez, 1999; Sam, Lau, & Kwan, 2023).

Cadmus addresses the reliability challenge through **similarity-based auto-marking**: the system compares student responses against a set of expected key terms. The prompt templates instruct authors to provide **3–6 semicolon-separated key terms** including synonyms and common phrasings, which improves the auto-marker's coverage and reduces false negatives.

Very-short-answer questions (VSAQs) — a closely related format — have been shown to achieve high reliability and discrimination while being perceived as more authentic by both students and faculty (Sam et al., 2018), supporting the inclusion of short answer items alongside selected-response types.

---

## Bloom's Taxonomy alignment

All prompt templates and the agentic pipeline use the **revised Bloom's taxonomy** (Anderson & Krathwohl, 2001), which organises cognitive processes into six levels: Remember, Understand, Apply, Analyse, Evaluate, and Create. The revision introduced a two-dimensional framework crossing cognitive process with knowledge type (factual, conceptual, procedural, metacognitive), making it more actionable for assessment design.

The extension applies Bloom levels as **tags** (`bloom-remember`, `bloom-apply`, etc.) rather than as structural metadata. This is deliberate — it allows filtering and reporting by cognitive level without constraining how the library is organised.

The Quality Reviewer agent in the agentic pipeline validates Bloom alignment by checking that:

- **Remember** questions test recall, not inference
- **Apply** questions present a novel scenario, not a textbook example
- **Analyse** questions require decomposition or comparison, not simple recall of relationships

This validation step is critical because research has shown that self-reported Bloom alignment by item authors is often inaccurate, with items labelled as higher-order frequently functioning at the Remember or Understand level (Crowe, Dirks, & Wenderoth, 2008).

---

## Difficulty calibration

The three-level difficulty scheme (Easy, Medium, Hard) maps to cognitive load rather than content obscurity:

| Level | Cognitive demand | Typical Bloom levels |
|-------|-----------------|---------------------|
| **Easy** | Single-step recall or direct application | Remember, Understand |
| **Medium** | Connecting 2+ concepts; applying in a contextual scenario | Understand, Apply |
| **Hard** | Multi-step reasoning; cross-topic analysis; edge cases | Analyse, Evaluate, Create |

This mapping is intentionally loose — a Remember item about a rarely taught concept can legitimately be Hard, and an Apply item with a well-scaffolded scenario can be Easy. The prompts instruct models to calibrate difficulty based on **cognitive demand**, not on how obscure the content is.

The recommended distribution for a balanced assessment is approximately **30% Easy, 50% Medium, 20% Hard**, following principles of constructive alignment (Biggs & Tang, 2011) where the assessment difficulty curve mirrors the expected distribution of student performance.

---

## Number of questions

The number of questions to generate is **always specified by the user** in the prompt — it is never defaulted by the templates. This is a deliberate design choice grounded in two considerations:

1. **Content coverage**: The appropriate number of items depends on the breadth of content to be assessed, the weight of the assessment, and the available testing time. A 10-item quiz for a single lecture requires a very different bank than a 60-item end-of-term exam.

2. **Sampling adequacy**: Measurement theory holds that reliability increases with test length (the Spearman-Brown prophecy formula), but with diminishing returns. There is no single "correct" number — it depends on the desired reliability coefficient and the homogeneity of the item pool.

The Curriculum Analyst agent in the agentic pipeline is instructed to propose a type-by-topic allocation that sums to the user's requested total, distributing items in proportion to the breadth and importance of each topic.

---

## References

Anderson, L. W., & Krathwohl, D. R. (Eds.). (2001). *A taxonomy for learning, teaching, and assessing: A revision of Bloom's taxonomy of educational objectives* (Complete ed.). Longman.

Biggs, J., & Tang, C. (2011). *Teaching for quality learning at university* (4th ed.). Open University Press.

Crowe, A., Dirks, C., & Wenderoth, M. P. (2008). Biology in Bloom: Implementing Bloom's taxonomy to enhance student learning in biology. *CBE—Life Sciences Education*, 7(4), 368–381.

Gellert, A. S., & Elbro, C. (2025). Cloze test performance and cognitive abilities: A comprehensive meta-analysis. *Intelligence*, 109, 101892.

Gierl, M. J., Bulut, O., Guo, Q., & Zhang, X. (2017). Developing, analyzing, and using distractors for multiple-choice tests in education: A comprehensive review. *Review of Educational Research*, 87(6), 1082–1116.

Haladyna, T. M. (2004). *Developing and validating multiple-choice test items* (3rd ed.). Routledge.

Haladyna, T. M., & Downing, S. M. (1993). How many options is enough for a multiple-choice test item? *Educational and Psychological Measurement*, 53(4), 999–1010.

Haladyna, T. M., Downing, S. M., & Rodriguez, M. C. (2002). A review of multiple-choice item-writing guidelines for classroom assessment. *Applied Measurement in Education*, 15(3), 309–333.

Kleijn, S., Pander Maat, H., & Sanders, T. (2019). Cloze testing for comprehension assessment: The HyTeC-cloze. *Language Testing*, 36(4), 553–572.

Martinez, M. E. (1999). Cognition and the question of test item format. *Educational Psychologist*, 34(4), 207–218.

Rodriguez, M. C. (2005). Three options are optimal for multiple-choice items: A meta-analysis of 80 years of research. *Educational Measurement: Issues and Practice*, 24(2), 3–13.

Sam, A. H., Lau, C. S., & Kwan, C. Y. (2023). What have we learned about constructed response short-answer questions from students and faculty? A multi-institutional study. *BMC Medical Education*, 23, 681.

Sam, A. H., et al. (2018). Very-short-answer questions: Reliability, discrimination and acceptability. *Medical Education*, 52(4), 447–455.
