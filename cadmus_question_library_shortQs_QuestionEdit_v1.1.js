/*
How it works:

- Reads your OPTIONS at the top — just change points and shuffle there
- Filters the selection to MCQs only, warns you about anything else that was selected
- Sets points in a single bulk call via UpdateQuestionAttributes
- Sets shuffle per-question via updateQuestionVersion (required because it needs the full body)

*/

(async () => {
  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const OPTIONS = {
    points:     2,   // number – points per question
    similarity: 60,  // number – required similarity % (0–100)
  };
  // ───────────────────────────────────────────────────────────────────────────

  const loc          = window.location.href;
  const tenant       = loc.split('/')[3];
  const assessmentId = loc.match(/assessment\/([^/]+)/)?.[1];
  if (!tenant || !assessmentId) { alert('Could not parse tenant/assessmentId from URL'); return; }

  // --- Find TanStack table ---
  let fKey = null;
  for (const d of document.querySelectorAll('div')) {
    const k = Object.keys(d).find(k => k.startsWith('__reactFiber'));
    if (k) { fKey = k; break; }
  }
  let table = null;
  for (const inp of document.querySelectorAll('input[type="checkbox"]')) {
    const fiber = inp[fKey];
    if (!fiber) continue;
    let node = fiber, depth = 0;
    while (node && depth < 80) {
      if (node.memoizedProps?.table && typeof node.memoizedProps.table.getSelectedRowModel === 'function') { table = node.memoizedProps.table; break; }
      let s = node.memoizedState;
      while (s) { if (s.memoizedState && typeof s.memoizedState?.getSelectedRowModel === 'function') { table = s.memoizedState; break; } s = s?.next; }
      if (table) break;
      node = node.return; depth++;
    }
    if (table) break;
  }
  if (!table) { alert('Could not find table instance'); return; }

  const allRows = table.getSelectedRowModel().rows;
  const rows    = allRows.filter(r => r.original.questionType === 'SHORT');
  const skipped = allRows.length - rows.length;
  if (skipped > 0) console.warn(`⚠ Skipped ${skipped} non-SHORT question(s)`);
  if (rows.length === 0) { alert('No SHORT answer questions selected'); return; }
  console.log(`Processing ${rows.length} SHORT question(s)…`);

  const GQL     = 'https://api.cadmus.io/cadmus/api/graphql';
  const headers = {
    'Content-Type':        'application/json',
    'x-cadmus-role':       'AUTHOR',
    'x-cadmus-tenant':     tenant,
    'x-cadmus-assessment': assessmentId,
  };

  // --- Step 1: Bulk set points ---
  const ATTRS_MUT = `mutation UpdateQuestionAttributes($questionIds: [ID!]!, $input: QuestionAttributesInput!) {
    updateQuestionAttributes(questionIds: $questionIds, input: $input) { id points }
  }`;
  const ar = await fetch(GQL, { method: 'POST', credentials: 'include', headers,
    body: JSON.stringify({ query: ATTRS_MUT, variables: { questionIds: rows.map(r => r.original.id), input: { points: OPTIONS.points } } })
  });
  const ad = await ar.json();
  if (ad.errors) console.error('❌ Points update failed:', ad.errors);
  else console.log(`✓ Points set to ${OPTIONS.points} for ${rows.length} question(s)`);

  // --- Fetch query ---
  const FETCH_Q = `query GetQ($questionId: ID!) {
    question(questionId: $questionId) {
      id questionType shortPrompt parentQuestionId shuffle points
      body { feedback promptDoc fields {
        identifier
        response { partialScoring matchSimilarity errorMargin correctValues caseSensitive cardinality baseType }
        interaction { __typename
          ... on TextEntryInteraction { expectedLength attachmentEnabled }
        }
      }}
    }
  }`;

  // --- Update mutation ---
  const UPDATE_Q = `mutation updateQuestionVersion($input: UpdateQuestionVersionInput!, $childrenQuestions: [UpdateQuestionVersionInput!]!) {
    updateQuestionVersion(input: $input, childrenQuestions: $childrenQuestions) {
      id points body { fields { response { matchSimilarity } } }
    }
  }`;

  const similarityFloat = OPTIONS.similarity / 100;

  // --- Step 2: Per-question similarity update ---
  for (const row of rows) {
    const qId = row.original.id;

    const fr = await fetch(GQL, { method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ query: FETCH_Q, variables: { questionId: qId } })
    });
    const fd = await fr.json();
    if (fd.errors) { console.error(`❌ Fetch failed for ${qId}:`, fd.errors); continue; }
    const q     = fd.data.question;
    const field = q.body.fields[0];
    const inter = field.interaction;

    const input = {
      id: q.id,
      attributes: {
        promptDoc:        q.body.promptDoc,
        questionType:     q.questionType,
        shortPrompt:      q.shortPrompt,
        feedback:         q.body.feedback,
        promptImage:      null,
        parentQuestionId: q.parentQuestionId,
        points:           OPTIONS.points,
        shuffle:          false,
        fields: [{
          identifier: field.identifier,
          response: {
            partialScoring:  null,
            matchSimilarity: similarityFloat,
            correctValues:   field.response.correctValues,
            correctRanges:   [],
            correctAreas:    [],
            caseSensitive:   field.response.caseSensitive,
            errorMargin:     null,
            baseType:        null,
          },
          textEntryInteraction: {
            expectedLength:    inter.expectedLength    ?? null,
            attachmentEnabled: inter.attachmentEnabled ?? null,
          },
        }],
      },
    };

    const ur = await fetch(GQL, { method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ query: UPDATE_Q, variables: { input, childrenQuestions: [] } })
    });
    const ud = await ur.json();
    if (ud.errors) console.error(`❌ Update failed for ${qId}:`, ud.errors);
    else {
      const sim = ud.data.updateQuestionVersion.body.fields[0].response.matchSimilarity;
      console.log(`✓ ${qId} — similarity: ${Math.round(sim * 100)}%, points: ${ud.data.updateQuestionVersion.points}`);
    }
  }

  // --- Step 3: Refresh library ---
  await window.__APOLLO_CLIENT__.refetchQueries({ include: ['LibraryQuestions'] });
  console.log('✅ Done — library refreshed');
})();