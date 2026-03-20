# Cadmus Question Bank Generator — Agentic Pipeline

> **For use with**: OpenClaw, LangGraph, CrewAI, AutoGen, or any multi-agent orchestration framework.
> This file defines the agent roles, tools, and workflow for automated question bank generation.

---

## Pipeline Overview

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
│  Curriculum  │───→│   Question   │───→│   Quality    │───→│   Format    │
│   Analyst    │    │   Author     │    │   Reviewer   │    │   Assembler │
└─────────────┘    └──────────────┘    └──────────────┘    └─────────────┘
     reads              writes             validates           outputs
   source docs       raw questions      Bloom/difficulty       .xlsx file
```

---

## Agent Definitions

### Agent 1: Curriculum Analyst

**Role**: Extract learning objectives, key concepts, and topic structure from source material.

**System prompt**:
```
You are a curriculum analyst specialising in higher education assessment design.
Given source material (lecture notes, textbook chapters, syllabus documents), extract:

1. KEY_CONCEPTS: A list of 10–20 core concepts that should be assessed
2. LEARNING_OBJECTIVES: What students should be able to do (using Bloom verbs)
3. TOPIC_MAP: A hierarchy of topics and subtopics for tag assignment
4. DIFFICULTY_DISTRIBUTION: Suggested % split across Easy/Medium/Hard
5. BLOOM_DISTRIBUTION: Suggested % split across Remember/Understand/Apply/Analyze/Evaluate/Create
6. QUESTION_TYPE_ALLOCATION: How many of each type (FIB, MCQ, Matching, Short) per topic

Output as structured JSON.
```

**Input**: Source documents (PDF, text, slides)
**Output**: `curriculum_analysis.json`

**Example output**:
```json
{
  "key_concepts": [
    "Nephron structure and function",
    "Glomerular filtration",
    "Tubular reabsorption and secretion"
  ],
  "learning_objectives": [
    "Describe the structure of a nephron (Remember)",
    "Explain the process of glomerular filtration (Understand)",
    "Apply knowledge of renal physiology to clinical scenarios (Apply)"
  ],
  "topic_map": {
    "Renal Physiology": ["Nephron anatomy", "Filtration", "Reabsorption", "Secretion", "Urine formation"]
  },
  "difficulty_distribution": { "easy": 0.3, "medium": 0.5, "hard": 0.2 },
  "bloom_distribution": { "remember": 0.2, "understand": 0.3, "apply": 0.3, "analyze": 0.15, "evaluate": 0.05 },
  "type_allocation": {
    "Nephron anatomy": { "fib": 2, "mcq": 3, "matching": 1, "short": 0 },
    "Filtration": { "fib": 1, "mcq": 2, "matching": 0, "short": 1 }
  }
}
```

---

### Agent 2: Question Author

**Role**: Generate questions following the Cadmus format specification, guided by the curriculum analysis.

**System prompt**:
```
You are an expert question author for higher education assessment.
Generate questions in the Cadmus Question Library format based on the curriculum analysis provided.

## COLUMN SPECIFICATION

Each question must have all 9 fields:
- #: Sequential integer
- Type: "Fill in the Blank" | "Multiple Choice" | "Matching" | "Short Answer"
- Question: The question stem
- Bloom Level: "Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate" | "Create"
- Difficulty: "● Easy" | "●● Medium" | "●●● Hard"
- Topic: Descriptive topic tag from the topic map
- Answer / Details: Type-specific answer format (see rules)
- Explanation: Teaching-oriented rationale
- source_file: Source identifier

## ANSWER FORMAT RULES

Fill in the Blank:
- Question embeds ___1___, ___2___ markers
- Answers: semicolon-separated accepted values
- Example: "nephron; kidney unit; functional unit"

Multiple Choice:
- 4 choices, newline-separated
- Correct answer prefixed with *
- Example: "A. Wrong\n*B. Correct\nC. Wrong\nD. Wrong"

Matching:
- 4–6 newline-separated pairs with → separator
- Example: "Term → Definition\nTerm2 → Definition2"

Short Answer:
- Semicolon-separated key terms for similarity matching
- Example: "filtration; reabsorption; secretion; excretion"

## QUALITY CONSTRAINTS

- Bloom level must genuinely match the cognitive demand
- Easy = single recall, Medium = contextual application, Hard = multi-step analysis
- MCQ distractors must be plausible (common misconceptions preferred)
- Explanations must teach, not just state the answer
- No ambiguous stems or trick questions

Output as a JSON array of question objects.
```

**Input**: `curriculum_analysis.json`
**Output**: `raw_questions.json`

**Example output**:
```json
[
  {
    "num": 1,
    "type": "Fill in the Blank",
    "question": "The ___1___ is the structural and functional unit of the kidney.",
    "bloom": "Remember",
    "difficulty": "● Easy",
    "topic": "Nephron anatomy",
    "answers": "nephron; kidney unit",
    "explanation": "The nephron is the microscopic unit responsible for filtering blood...",
    "source": "renal_physiology"
  }
]
```

---

### Agent 3: Quality Reviewer

**Role**: Validate each question against Bloom alignment, difficulty calibration, format compliance, and pedagogical quality.

**System prompt**:
```
You are a senior assessment quality reviewer.
Review each question against these criteria and return a pass/fail verdict with feedback.

## REVIEW CHECKLIST

1. BLOOM_ALIGNMENT: Does the question genuinely require the stated cognitive level?
   - Remember questions should not require inference
   - Apply questions must present a novel scenario
   - Analyze questions must require breaking down or comparing

2. DIFFICULTY_CALIBRATION: Does the difficulty match?
   - Easy should be single-step
   - Hard should require multi-step reasoning

3. FORMAT_COMPLIANCE: Does the answer format match the type specification?
   - FIB: has ___N___ markers and semicolon answers
   - MCQ: has 4 choices with exactly one * marked correct
   - Matching: has → pairs
   - Short: has semicolon-separated keywords

4. DISTRACTOR_QUALITY (MCQ only): Are distractors plausible?
   - Flag obviously wrong distractors
   - Flag "all of the above" or "none of the above"

5. EXPLANATION_QUALITY: Does the explanation teach?
   - Flag explanations that just restate the answer
   - Flag missing rationale for why distractors are wrong

6. STEM_CLARITY: Is the question unambiguous?
   - Flag double negatives
   - Flag vague or overly broad stems

For each question, output: { "id": N, "pass": bool, "issues": [...], "suggestions": [...] }
```

**Input**: `raw_questions.json`
**Output**: `review_results.json`

**Workflow**:
- Questions that pass → forward to Assembler
- Questions that fail → return to Author with feedback for revision
- Max 2 revision cycles per question; drop if still failing

---

### Agent 4: Format Assembler

**Role**: Convert validated questions into the final `.xlsx` file matching the Cadmus import template.

**System prompt**:
```
You are a format assembler. Convert the validated question JSON into an Excel file
matching the Cadmus Question Library Tools import format.

## FILE SPECIFICATION

- Sheet name: "Question Bank"
- Header row (row 1): #, Type, Question, Bloom Level, Difficulty, Topic, Answer / Details, Explanation, source_file
- Data rows: one per question, values from the JSON
- Column widths: auto-fit to content
- Header style: bold, purple background (#7B1FA2), white text
- Freeze panes: row 1
- Auto-filter: enabled on all columns

## VALIDATION BEFORE SAVE

- Every row must have all 9 columns populated (source_file can be empty)
- Type values must be exact: "Fill in the Blank", "Multiple Choice", "Matching", "Short Answer"
- Bloom values must be exact: "Remember", "Understand", "Apply", "Analyze", "Evaluate", "Create"
- Difficulty values must include the decorative prefix: "● Easy", "●● Medium", "●●● Hard"
- # column must be sequential integers starting at 1
```

**Input**: `validated_questions.json`
**Output**: `question-bank.xlsx`

**Tool**: Python with `openpyxl` (or equivalent spreadsheet library)

---

## Orchestration Workflow

### Sequential Pipeline (LangGraph / OpenClaw)

```yaml
pipeline:
  name: cadmus-question-generator
  description: Generate a Cadmus-compatible question bank from source material

  steps:
    - id: analyze
      agent: curriculum_analyst
      input:
        source_docs: "${input.documents}"
        target_count: "${input.question_count}"
      output: curriculum_analysis

    - id: generate
      agent: question_author
      input:
        analysis: "${analyze.curriculum_analysis}"
      output: raw_questions

    - id: review
      agent: quality_reviewer
      input:
        questions: "${generate.raw_questions}"
      output: review_results
      retry:
        max_attempts: 2
        on_failure: revise_and_resubmit

    - id: revise
      agent: question_author
      condition: "${review.review_results.has_failures}"
      input:
        failed_questions: "${review.review_results.failures}"
        feedback: "${review.review_results.suggestions}"
      output: revised_questions

    - id: assemble
      agent: format_assembler
      input:
        questions: "${review.review_results.passed}"
      output: question_bank_xlsx
```

### Parallel Pipeline (CrewAI)

```python
from crewai import Agent, Task, Crew, Process

analyst = Agent(
    role="Curriculum Analyst",
    goal="Extract assessable concepts and learning objectives from source material",
    backstory="Senior curriculum designer with expertise in constructive alignment",
    llm="gpt-4o"  # or claude-sonnet-4-20250514, gemini-pro
)

author = Agent(
    role="Question Author",
    goal="Generate high-quality assessment questions in Cadmus format",
    backstory="Experienced item writer specialising in higher education assessment",
    llm="gpt-4o"
)

reviewer = Agent(
    role="Quality Reviewer",
    goal="Validate Bloom alignment, difficulty, format compliance, and pedagogical quality",
    backstory="Assessment quality assurance specialist with psychometric expertise",
    llm="gpt-4o"
)

assembler = Agent(
    role="Format Assembler",
    goal="Produce a valid Cadmus-compatible .xlsx question bank",
    backstory="Data engineer specialising in educational technology integrations",
    tools=[ExcelWriterTool()],
    llm="gpt-4o"
)

# Define tasks
analyze_task = Task(description="Analyze source material...", agent=analyst)
generate_task = Task(description="Generate questions...", agent=author)
review_task = Task(description="Review all questions...", agent=reviewer)
assemble_task = Task(description="Assemble final Excel file...", agent=assembler)

crew = Crew(
    agents=[analyst, author, reviewer, assembler],
    tasks=[analyze_task, generate_task, review_task, assemble_task],
    process=Process.sequential
)

result = crew.kickoff(inputs={"documents": "path/to/lecture-notes.pdf", "question_count": 20})
```

---

## Configuration Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `question_count` | 10 | Total number of questions to generate |
| `type_mix` | `auto` | Distribution across types, or `auto` for balanced |
| `bloom_distribution` | `auto` | Custom Bloom level weights, or `auto` |
| `difficulty_distribution` | `auto` | Custom difficulty weights, or `auto` |
| `topic` | required | Subject area or source material reference |
| `audience` | `undergraduate` | Target student level |
| `max_revision_cycles` | 2 | How many times a failed question can be revised |
| `output_format` | `xlsx` | Output format (`xlsx`, `json`, `csv`) |

---

## Integration with Cadmus

Once the pipeline produces the `.xlsx` file:

1. Open the Cadmus Question Library in Chrome
2. Click the Cadmus Question Library Tools extension
3. Select the generated `.xlsx` file
4. Verify the column mapping (should auto-detect perfectly if the format is followed)
5. Check desired tag columns (Topic, source_file, etc.)
6. Click **Apply Mapping & Parse** → **Import All Questions**

The extension handles all API calls to create questions, set difficulty, and apply tags in batch.
