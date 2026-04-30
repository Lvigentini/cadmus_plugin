# Essay Evaluation — Quick Console Scripts

Two snippets that use your active Claude.ai browser session to evaluate essay (long-form) responses from a Cadmus assessment. No extension changes needed. Runs entirely in DevTools.

---

## Prerequisites

- The Cadmus **submission review** or **grading** page is open and fully loaded in one tab
- You are logged into **claude.ai** in another tab (same browser window)
- DevTools open on each tab when needed (`F12`)

---

## Step 0 — Discover what question types exist (optional)

If you are unsure what Cadmus calls essay questions in this assessment, paste this in the **Cadmus tab** console first:

```js
(() => {
  const cache = window.__APOLLO_CLIENT__?.cache?.extract() ?? {};
  const types = {};
  Object.values(cache).forEach(v => {
    if (v?.__typename === 'Question' && v.questionType)
      types[v.questionType] = (types[v.questionType] || 0) + 1;
  });
  console.table(types);
})();
```

This prints a table like:

| questionType | count |
|---|---|
| SHORT | 4 |
| BLANKS | 12 |
| MCQ | 8 |
| ESSAY | 2 |

Note the exact type name — you will need it in Snippet A. Common Cadmus names: `ESSAY`, `LONG_ANSWER`, `EXTENDED`.

---

## Snippet A — Extract essay data (run in the Cadmus tab)

Paste into the Cadmus tab console. Set `ESSAY_TYPE` to match Step 0.

```js
(async () => {
  const ESSAY_TYPE = 'ESSAY'; // ← change to match your assessment

  const cache = window.__APOLLO_CLIENT__?.cache?.extract();
  if (!cache) { console.error('Apollo cache not found — is the Cadmus page fully loaded?'); return; }

  // Pull question bodies from cache
  const questions = {};
  Object.values(cache).forEach(v => {
    if (v?.__typename === 'Question' && v.questionType === ESSAY_TYPE && v.id) {
      questions[v.id] = {
        id: v.id,
        points: v.points ?? 1,
        prompt: (() => {
          const doc = v.body?.promptDoc;
          if (!doc) return v.shortPrompt || '';
          const walk = n => {
            if (!n) return '';
            if (n.text) return n.text;
            return (n.content || []).map(walk).join('');
          };
          return walk(doc);
        })(),
        // Essay questions typically have no model answer; include if present
        modelAnswer: v.body?.fields?.[0]?.correctValues?.[0] || '',
      };
    }
  });

  if (!Object.keys(questions).length) {
    console.error(`No ${ESSAY_TYPE} questions found. Run Step 0 to check available types.`);
    return;
  }
  console.log(`Found ${Object.keys(questions).length} ${ESSAY_TYPE} question(s).`);

  // Pull student responses from work outcomes in cache
  const rows = [];
  Object.values(cache).forEach(v => {
    if (v?.__typename !== 'WorkOutcome') return;
    const student = cache[`Student:${v.studentId}`] || cache[`User:${v.studentId}`] || {};
    (v.questionOutcomes || []).forEach(ref => {
      const qo = cache[ref.__ref] || ref;
      if (!questions[qo.questionId]) return;
      const q = questions[qo.questionId];
      (qo.fieldOutcomes || []).forEach(fref => {
        const fo = cache[fref.__ref] || fref;
        const texts = (fo.studentValues || [])
          .map(r => cache[r.__ref] || r)
          .map(sv => sv.text || sv.value || '')
          .filter(Boolean);
        rows.push({
          FieldOutcomeId: fo.id,
          StudentName: student.name || student.fullName || v.studentId,
          StudentID: student.sisId || v.studentId,
          StudentEmail: student.email || '',
          QuestionID: q.id,
          QuestionPrompt: q.prompt,
          ModelAnswer: q.modelAnswer,
          QuestionMaxScore: q.points,
          StudentAnswer: texts.join('\n\n').trim(),
          FieldScore: fo.score ?? 0,
          // Placeholders — filled by Snippet B
          LLMScore: '', LLMFlag: '', LLMJustification: '',
        });
      });
    });
  });

  if (!rows.length) {
    console.warn('Questions found but no student responses in cache. Try navigating to the submission list first so Cadmus loads the work outcomes.');
    return;
  }

  console.log(`Extracted ${rows.length} student responses across ${Object.keys(questions).length} question(s).`);

  // Group by question for display
  Object.values(questions).forEach(q => {
    const n = rows.filter(r => r.QuestionID === q.id).length;
    console.log(`  Q[${q.id.slice(0,8)}…] "${q.prompt.slice(0,80)}…" — ${n} responses, max ${q.points} pts`);
  });

  // Copy to clipboard as JSON
  const payload = JSON.stringify({ questions: Object.values(questions), rows }, null, 2);
  await navigator.clipboard.writeText(payload);
  console.log('✓ Data copied to clipboard. Now go to the claude.ai tab and run Snippet B.');

  window.__essayData = { questions: Object.values(questions), rows };
})();
```

---

## Snippet B — Evaluate with Claude (run in the claude.ai tab)

Open the **claude.ai tab**, paste this into its DevTools console. It reads the clipboard, calls the Claude API using your active session, and downloads a CSV when done.

```js
(async () => {
  // ── Config ────────────────────────────────────────────────────────────────
  const MODEL = 'claude-haiku-4-5';   // fast + cheap; change to claude-sonnet-4-6 for harder rubrics
  const MAX_TOKENS = 4096;
  const DELAY_MS = 1500;              // ms between question batches (courtesy throttle)

  // ── Load data from clipboard ──────────────────────────────────────────────
  const raw = await navigator.clipboard.readText();
  let payload;
  try { payload = JSON.parse(raw); } catch {
    console.error('Clipboard does not contain valid JSON. Run Snippet A first.'); return;
  }
  const { questions, rows } = payload;
  console.log(`Loaded ${rows.length} responses across ${questions.length} question(s).`);

  // ── Claude session ────────────────────────────────────────────────────────
  const orgRes = await fetch('/api/organizations');
  if (!orgRes.ok) { console.error('Not logged in to Claude.ai — check your session.'); return; }
  const orgs = await orgRes.json();
  const orgId = Array.isArray(orgs) ? orgs[0]?.uuid : orgs?.uuid;
  if (!orgId) { console.error('No org ID found.'); return; }

  // ── SSE stream collector ──────────────────────────────────────────────────
  async function streamCompletion(base, convId, promptText) {
    const res = await fetch(`${base}/chat_conversations/${convId}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: `\n\nHuman: ${promptText}\n\nAssistant:`,
        model: MODEL,
        max_tokens_to_sample: MAX_TOKENS,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attachments: [], files: [],
      }),
    });
    if (!res.ok) throw new Error(`Completion failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try { text += JSON.parse(raw).completion ?? ''; } catch {}
      }
    }
    return text;
  }

  // ── Call Claude for one question (all students batched) ───────────────────
  async function evaluateQuestion(q, questionRows) {
    const base = `/api/organizations/${orgId}`;
    const maxScore = q.points ?? 1;
    const step = maxScore / 4;
    const validScores = [0,1,2,3,4].map(n => parseFloat((n*step).toFixed(4))).join(', ');

    const SYSTEM = [
      'You are an academic essay evaluator. You will receive a question, an optional model answer, and a list of numbered student essays.',
      'Return ONLY a JSON array — one object per student in order — with these keys:',
      '  score   (number): the actual point value. Valid values: ' + validScores,
      '  flag    (string): one of STRONG | ADEQUATE | WEAK | OFF_TOPIC | SKIP | ERROR',
      '  justification (string): 1-3 sentences explaining the score.',
      '',
      'Flag definitions:',
      '  STRONG    — essay addresses the question with clear argument and evidence; score >= 75% of max',
      '  ADEQUATE  — essay is relevant and has some substance but lacks depth, evidence, or completeness; score 25-74% of max',
      '  WEAK      — response makes minimal relevant points or has significant gaps; score < 25% of max but > 0',
      '  OFF_TOPIC — response does not address the question; score 0',
      '  SKIP      — response is blank or too short to evaluate; score 0',
      '  ERROR     — you cannot evaluate this response for a technical reason; score 0',
    ].join('\n');

    const numbered = questionRows
      .map((r, i) => `[${i+1}] ${r.StudentAnswer || '(blank)'}`)
      .join('\n\n');

    const USER = [
      `QUESTION: ${q.prompt}`,
      q.modelAnswer ? `SUGGESTED ANSWER: ${q.modelAnswer}` : '(no model answer provided)',
      `MAX SCORE: ${maxScore} points`,
      '',
      `STUDENT ESSAYS (${questionRows.length} total):`,
      numbered,
    ].join('\n');

    // Create temp conversation
    const convRes = await fetch(`${base}/chat_conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', uuid: crypto.randomUUID() }),
    });
    if (!convRes.ok) throw new Error(`Conversation create failed: ${convRes.status}`);
    const { uuid: convId } = await convRes.json();

    let text;
    try {
      text = await streamCompletion(base, convId, `[System: ${SYSTEM}]\n\n${USER}`);
    } finally {
      fetch(`${base}/chat_conversations/${convId}`, { method: 'DELETE' }).catch(() => {});
    }

    // Parse JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }

  // ── Main loop ─────────────────────────────────────────────────────────────
  const resultMap = {};   // FieldOutcomeId → { LLMScore, LLMFlag, LLMJustification }

  for (const q of questions) {
    const questionRows = rows.filter(r => r.QuestionID === q.id);
    if (!questionRows.length) continue;

    console.log(`Evaluating "${q.prompt.slice(0, 60)}…" — ${questionRows.length} responses…`);
    try {
      const results = await evaluateQuestion(q, questionRows);
      results.forEach((res, i) => {
        const row = questionRows[i];
        if (!row) return;
        resultMap[row.FieldOutcomeId] = {
          LLMScore: res.score ?? '',
          LLMFlag: res.flag ?? 'ERROR',
          LLMJustification: (res.justification || '').replace(/"/g, '""'),
        };
      });
      console.log(`  ✓ ${results.length} responses scored`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      questionRows.forEach(r => {
        resultMap[r.FieldOutcomeId] = { LLMScore: '', LLMFlag: 'ERROR', LLMJustification: err.message };
      });
    }

    if (questions.indexOf(q) < questions.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ── Merge results + download CSV ──────────────────────────────────────────
  const merged = rows.map(r => ({ ...r, ...(resultMap[r.FieldOutcomeId] || {}) }));

  const cols = ['StudentName','StudentID','StudentEmail','QuestionID','QuestionPrompt',
    'ModelAnswer','StudentAnswer','QuestionMaxScore','FieldScore',
    'LLMScore','LLMFlag','LLMJustification','FieldOutcomeId'];

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...merged.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `essay_eval_${new Date().toISOString().slice(0,10)}.csv`,
  });
  document.body.appendChild(a); a.click(); a.remove();
  console.log(`✓ Done — ${merged.length} rows exported.`);
})();
```

---

## Output columns

| Column | Description |
|--------|-------------|
| `StudentName` / `StudentID` / `StudentEmail` | Student identity from Cadmus |
| `QuestionID` | Cadmus question identifier |
| `QuestionPrompt` | Full question text |
| `ModelAnswer` | Model answer if configured (often blank for essays) |
| `StudentAnswer` | Student's submitted essay |
| `QuestionMaxScore` | Total points available |
| `FieldScore` | Current Cadmus-assigned score |
| `LLMScore` | Claude's recommended score in quarter steps (same units as `FieldScore`) |
| `LLMFlag` | STRONG / ADEQUATE / WEAK / OFF_TOPIC / SKIP / ERROR |
| `LLMJustification` | 1-3 sentence rationale |
| `FieldOutcomeId` | Unique row key — use to match rows if re-running |

## LLMFlag guide

| Flag | Meaning | Typical score |
|------|---------|---------------|
| `STRONG` | Clear argument, evidence used, directly addresses the question | ≥ 75% of max |
| `ADEQUATE` | Relevant but incomplete — thin on evidence or depth | 25–74% of max |
| `WEAK` | Minimal relevant content, significant gaps | < 25% of max |
| `OFF_TOPIC` | Does not address the question asked | 0 |
| `SKIP` | Blank or near-blank submission | 0 |
| `ERROR` | Evaluation failed | — |

---

## Notes

- **Large cohorts**: Claude.ai's web session has stricter rate limits than the API. If you get 429 errors, increase `DELAY_MS` to 3000 or 5000.
- **Model choice**: `claude-haiku-4-5` is fast and handles straightforward rubrics well. Switch to `claude-sonnet-4-6` for complex disciplinary marking.
- **No model answer**: Most essay questions in Cadmus have no configured model answer. Claude will evaluate based on the question text alone — the quality of the prompt matters more than usual.
- **Cadmus response loading**: If Snippet A finds questions but no responses, navigate to the student submission list on the Cadmus page first (Cadmus loads work outcomes lazily as you browse submissions). Then run Snippet A again.
