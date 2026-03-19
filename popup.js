'use strict';

const $ = (sel) => document.querySelector(sel);
const log = (msg, cls = '') => {
  const el = $('#log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

// ── Find the Cadmus tab (works from both popup and window mode) ─────────────
let cadmusTabId = null;

async function findCadmusTab() {
  // Try all tabs matching Cadmus host
  const tabs = await chrome.tabs.query({ url: 'https://*.cadmus.io/*' });
  for (const tab of tabs) {
    const url = tab.url || '';
    const match = url.match(/cadmus\.io\/([^/]+)\/assessment\/([^/]+)\/library/);
    if (match) return tab;
  }
  return null;
}

// ── Check context on popup open ──────────────────────────────────────────────
async function checkContext() {
  const tab = await findCadmusTab();
  if (!tab) return setDisconnected('Navigate to a Cadmus Question Library');

  const url = tab.url || '';
  const match = url.match(/cadmus\.io\/([^/]+)\/assessment\/([^/]+)\/library/);
  if (!match) return setDisconnected('Navigate to a Cadmus Question Library');

  cadmusTabId = tab.id;
  const [, tenant, assessmentId] = match;
  setConnected(tenant, assessmentId);
}

function setConnected(tenant, assessmentId) {
  const status = $('#status');
  status.className = 'status status--connected';
  $('#status-text').textContent = `Library: ${tenant}`;
  $('#actions').classList.remove('disabled');
  // store for later use
  document.body.dataset.tenant = tenant;
  document.body.dataset.assessmentId = assessmentId;
}

function setDisconnected(msg) {
  const status = $('#status');
  status.className = 'status status--disconnected';
  $('#status-text').textContent = msg;
  $('#actions').classList.add('disabled');
}

// ── Run action in page context ───────────────────────────────────────────────
async function runAction(action, options) {
  if (!cadmusTabId) {
    log('No Cadmus tab found — refresh and try again', 'err');
    return;
  }

  // Disable all buttons while running
  document.querySelectorAll('.btn').forEach(b => b.disabled = true);
  log(`Running ${action}…`);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: cadmusTabId },
      world: 'MAIN',
      func: cadmusAction,
      args: [action, options],
    });

    const result = results[0]?.result;
    if (!result) {
      log('No result returned', 'err');
      return;
    }
    if (result.error) {
      log(result.error, 'err');
      return;
    }
    // Show per-item logs
    if (result.logs) {
      result.logs.forEach(l => log(l.msg, l.cls));
    }
    if (result.success) {
      log(`Done — ${result.processed} processed, ${result.skipped} skipped`, 'ok');
    }
  } catch (err) {
    log(`Error: ${err.message}`, 'err');
  } finally {
    document.querySelectorAll('.btn').forEach(b => b.disabled = false);
  }
}

// ── This function is serialized and injected into the page ───────────────────
function cadmusAction(action, options) {
  // --- Shared utilities ---
  function parseCadmusUrl() {
    const loc = window.location.href;
    const tenant = loc.split('/')[3];
    const assessmentId = loc.match(/assessment\/([^/]+)/)?.[1];
    return { tenant, assessmentId };
  }

  function findTanStackTable() {
    let fKey = null;
    for (const d of document.querySelectorAll('div')) {
      const k = Object.keys(d).find(k => k.startsWith('__reactFiber'));
      if (k) { fKey = k; break; }
    }
    if (!fKey) return null;

    let table = null;
    for (const inp of document.querySelectorAll('input[type="checkbox"]')) {
      const fiber = inp[fKey];
      if (!fiber) continue;
      let node = fiber, depth = 0;
      while (node && depth < 80) {
        if (node.memoizedProps?.table && typeof node.memoizedProps.table.getSelectedRowModel === 'function') {
          table = node.memoizedProps.table; break;
        }
        let s = node.memoizedState;
        while (s) {
          if (s.memoizedState && typeof s.memoizedState?.getSelectedRowModel === 'function') {
            table = s.memoizedState; break;
          }
          s = s?.next;
        }
        if (table) break;
        node = node.return; depth++;
      }
      if (table) break;
    }
    return table;
  }

  function getSelectedRows(filterType) {
    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };
    const allRows = table.getSelectedRowModel().rows;
    if (!allRows.length) return { error: 'No questions selected. Select rows using the checkboxes first.' };
    if (!filterType) return { rows: allRows, skipped: 0 };
    const rows = allRows.filter(r => r.original.questionType === filterType);
    return { rows, skipped: allRows.length - rows.length };
  }

  async function gql(query, variables, headers) {
    const r = await fetch('https://api.cadmus.io/cadmus/api/graphql', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query, variables }),
    });
    return r.json();
  }

  async function refreshLibrary() {
    if (window.__APOLLO_CLIENT__) {
      await window.__APOLLO_CLIENT__.refetchQueries({ include: ['LibraryQuestions'] });
    } else {
      // Fallback: find via React fiber
      const root = document.getElementById('root');
      const fk = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'));
      if (fk) {
        const queue = [root[fk]];
        const seen = new WeakSet();
        let n = 0, client = null;
        while (queue.length && n < 5000) {
          const f = queue.shift();
          if (!f || seen.has(f)) continue;
          seen.add(f); n++;
          const v = f.memoizedProps?.value;
          if (v?.refetchQueries && v?.cache) { client = v; break; }
          if (v?.client?.refetchQueries && v?.client?.cache) { client = v.client; break; }
          if (f.child) queue.push(f.child);
          if (f.sibling) queue.push(f.sibling);
        }
        if (client) await client.refetchQueries({ include: ['LibraryQuestions'] });
      }
    }
  }

  // --- Shared ID helpers ---
  const uuid = () => crypto.randomUUID();
  const nanoid = (len = 21) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  };

  // --- Simple prompt doc (no blanks) ---
  function simplePromptDoc(text) {
    return JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { indentSpecial: 'normal', indentLevel: 0, textAlign: 'left' },
        content: [{ type: 'text', text }] }]
    });
  }

  // --- Mutations ---
  const ATTRS_MUT = `mutation UpdateQuestionAttributes($questionIds: [ID!]!, $input: QuestionAttributesInput!) {
    updateQuestionAttributes(questionIds: $questionIds, input: $input) { id points }
  }`;

  const FETCH_Q = `query GetQ($questionId: ID!) {
    question(questionId: $questionId) {
      id questionType shortPrompt parentQuestionId shuffle points
      body { feedback promptDoc fields {
        identifier
        response { partialScoring matchSimilarity errorMargin correctValues caseSensitive cardinality baseType }
        interaction { __typename
          ... on ChoiceInteraction { choices { identifier content } maxChoices }
          ... on MatchInteraction { targetSet { identifier content } sourceSet { identifier content } }
          ... on TextEntryInteraction { expectedLength attachmentEnabled }
        }
      }}
    }
  }`;

  const UPDATE_Q = `mutation updateQuestionVersion($input: UpdateQuestionVersionInput!, $childrenQuestions: [UpdateQuestionVersionInput!]!) {
    updateQuestionVersion(input: $input, childrenQuestions: $childrenQuestions) {
      id shuffle points body { fields { response { matchSimilarity } } }
    }
  }`;

  const ARCHIVE_Q = `mutation ArchiveQuestion($questionId: ID!) {
    archiveQuestion(questionId: $questionId) { id __typename }
  }`;

  const CREATE_Q = `
    mutation CreateQuestion(
      $assessmentId: ID!
      $subjectId:    ID!
      $input:        QuestionAttributes!
      $childrenQuestions: [QuestionAttributes!]!
    ) {
      createQuestion(
        assessmentId: $assessmentId
        subjectId:    $subjectId
        input:        $input
        childrenQuestions: $childrenQuestions
      ) { id libraryId questionType shortPrompt points }
    }
  `;

  // --- Shared: fetch subjectId ---
  async function fetchSubjectId(assessmentId, hdrs) {
    const asmtRes = await gql(
      `query GetAssessment($assessmentId: ID!) {
         assessment(assessmentId: $assessmentId) { id subjectId }
       }`,
      { assessmentId },
      hdrs
    );
    return asmtRes?.data?.assessment?.subjectId || null;
  }

  // --- Action implementations ---
  async function editMCQ(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const sel = getSelectedRows('MCQ');
    if (sel.error) return sel;
    const { rows, skipped } = sel;
    if (!rows.length) return { error: 'No MCQ questions in selection' };

    const logs = [];
    if (skipped > 0) logs.push({ msg: `Skipped ${skipped} non-MCQ question(s)`, cls: 'warn' });

    // Bulk points
    const ad = await gql(ATTRS_MUT, { questionIds: rows.map(r => r.original.id), input: { points: opts.points } }, hdrs);
    if (ad.errors) { logs.push({ msg: `Points update failed: ${ad.errors[0].message}`, cls: 'err' }); return { error: 'Points update failed', logs }; }
    logs.push({ msg: `Points set to ${opts.points} for ${rows.length} question(s)`, cls: 'ok' });

    // Per-question shuffle
    for (const row of rows) {
      const qId = row.original.id;
      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed for ${qId}`, cls: 'err' }); continue; }
      const q = fd.data.question, field = q.body.fields[0], inter = field.interaction;
      const input = {
        id: q.id,
        attributes: {
          promptDoc: q.body.promptDoc, questionType: q.questionType, shortPrompt: q.shortPrompt,
          feedback: q.body.feedback, promptImage: null, parentQuestionId: q.parentQuestionId,
          points: opts.points, shuffle: opts.shuffle,
          fields: [{ identifier: field.identifier,
            response: { partialScoring: field.response.partialScoring, matchSimilarity: null, correctValues: field.response.correctValues, correctRanges: [], correctAreas: [], caseSensitive: field.response.caseSensitive, errorMargin: null, baseType: null },
            choiceInteraction: { choices: inter.choices.map(c => ({ identifier: c.identifier, content: c.content })), maxChoices: inter.maxChoices },
          }],
        },
      };
      const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (ud.errors) logs.push({ msg: `Update failed for ${qId}`, cls: 'err' });
      else logs.push({ msg: `${q.shortPrompt?.substring(0, 40) || qId} — shuffle: ${opts.shuffle}, points: ${opts.points}`, cls: 'ok' });
    }

    await refreshLibrary();
    return { success: true, processed: rows.length, skipped, logs };
  }

  async function editMatching(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const sel = getSelectedRows('MATCHING');
    if (sel.error) return sel;
    const { rows, skipped } = sel;
    if (!rows.length) return { error: 'No MATCHING questions in selection' };

    const logs = [];
    if (skipped > 0) logs.push({ msg: `Skipped ${skipped} non-MATCHING question(s)`, cls: 'warn' });

    const ad = await gql(ATTRS_MUT, { questionIds: rows.map(r => r.original.id), input: { points: opts.points } }, hdrs);
    if (ad.errors) { logs.push({ msg: `Points update failed: ${ad.errors[0].message}`, cls: 'err' }); return { error: 'Points update failed', logs }; }
    logs.push({ msg: `Points set to ${opts.points} for ${rows.length} question(s)`, cls: 'ok' });

    for (const row of rows) {
      const qId = row.original.id;
      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed for ${qId}`, cls: 'err' }); continue; }
      const q = fd.data.question, field = q.body.fields[0], inter = field.interaction;
      const input = {
        id: q.id,
        attributes: {
          promptDoc: q.body.promptDoc, questionType: q.questionType, shortPrompt: q.shortPrompt,
          feedback: q.body.feedback, promptImage: null, parentQuestionId: q.parentQuestionId,
          points: opts.points, shuffle: opts.shuffle,
          fields: [{ identifier: field.identifier,
            response: { partialScoring: field.response.partialScoring, matchSimilarity: null, correctValues: field.response.correctValues, correctRanges: [], correctAreas: [], caseSensitive: field.response.caseSensitive, errorMargin: null, baseType: null },
            matchInteraction: { sourceSet: inter.sourceSet.map(c => ({ identifier: c.identifier, content: c.content })), targetSet: inter.targetSet.map(c => ({ identifier: c.identifier, content: c.content })) },
          }],
        },
      };
      const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (ud.errors) logs.push({ msg: `Update failed for ${qId}`, cls: 'err' });
      else logs.push({ msg: `${q.shortPrompt?.substring(0, 40) || qId} — shuffle: ${opts.shuffle}, points: ${opts.points}`, cls: 'ok' });
    }

    await refreshLibrary();
    return { success: true, processed: rows.length, skipped, logs };
  }

  async function editShort(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const sel = getSelectedRows('SHORT');
    if (sel.error) return sel;
    const { rows, skipped } = sel;
    if (!rows.length) return { error: 'No SHORT answer questions in selection' };

    const logs = [];
    if (skipped > 0) logs.push({ msg: `Skipped ${skipped} non-SHORT question(s)`, cls: 'warn' });

    const ad = await gql(ATTRS_MUT, { questionIds: rows.map(r => r.original.id), input: { points: opts.points } }, hdrs);
    if (ad.errors) { logs.push({ msg: `Points update failed: ${ad.errors[0].message}`, cls: 'err' }); return { error: 'Points update failed', logs }; }
    logs.push({ msg: `Points set to ${opts.points} for ${rows.length} question(s)`, cls: 'ok' });

    const similarityFloat = opts.similarity / 100;
    for (const row of rows) {
      const qId = row.original.id;
      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed for ${qId}`, cls: 'err' }); continue; }
      const q = fd.data.question, field = q.body.fields[0], inter = field.interaction;
      const input = {
        id: q.id,
        attributes: {
          promptDoc: q.body.promptDoc, questionType: q.questionType, shortPrompt: q.shortPrompt,
          feedback: q.body.feedback, promptImage: null, parentQuestionId: q.parentQuestionId,
          points: opts.points, shuffle: false,
          fields: [{ identifier: field.identifier,
            response: { partialScoring: null, matchSimilarity: similarityFloat, correctValues: field.response.correctValues, correctRanges: [], correctAreas: [], caseSensitive: field.response.caseSensitive, errorMargin: null, baseType: null },
            textEntryInteraction: { expectedLength: inter.expectedLength ?? null, attachmentEnabled: inter.attachmentEnabled ?? null },
          }],
        },
      };
      const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (ud.errors) logs.push({ msg: `Update failed for ${qId}`, cls: 'err' });
      else {
        const sim = ud.data.updateQuestionVersion.body.fields[0].response.matchSimilarity;
        logs.push({ msg: `${q.shortPrompt?.substring(0, 40) || qId} — similarity: ${Math.round(sim * 100)}%, points: ${opts.points}`, cls: 'ok' });
      }
    }

    await refreshLibrary();
    return { success: true, processed: rows.length, skipped, logs };
  }

  async function deleteSelected() {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'lecturer', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId, 'x-cadmus-url': window.location.href };
    const sel = getSelectedRows();
    if (sel.error) return sel;
    const { rows } = sel;

    const logs = [];
    let errors = 0;
    for (const row of rows) {
      const { id, shortPrompt } = row.original;
      const d = await gql(ARCHIVE_Q, { questionId: id }, hdrs);
      if (d.errors) { logs.push({ msg: `Failed: ${shortPrompt?.substring(0, 50) || id}`, cls: 'err' }); errors++; }
      else logs.push({ msg: `Deleted: ${shortPrompt?.substring(0, 50) || id}`, cls: 'ok' });
    }

    await refreshLibrary();
    return { success: errors === 0, processed: rows.length - errors, skipped: 0, logs };
  }

  // --- Import Fill-in-Blank (BLANKS type) ---
  async function importFIB(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'lecturer',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    // Fetch subjectId
    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const buildPromptDoc = (promptTemplate, blankUUIDs) => {
      const segments = promptTemplate.split('___');
      const content = [];
      segments.forEach((seg, i) => {
        if (seg) content.push({ type: 'text', text: seg });
        if (i < blankUUIDs.length) {
          content.push({ type: 'blanks', attrs: { blanks: i, id: blankUUIDs[i] } });
        }
      });
      return JSON.stringify({
        type: 'doc',
        content: [{
          type: 'paragraph',
          attrs: { indentSpecial: 'normal', indentLevel: 0, textAlign: 'left' },
          content,
        }]
      });
    };

    const buildFields = (blanks, distractorPool, qIdx) =>
      blanks.map((blank, i) => {
        const correctTexts = blank.answers.map(a => a.toLowerCase());
        const choices = blank.answers.map(text => ({
          identifier: nanoid(),
          content: text,
        }));
        // All provided answers are correct
        const correctIds = choices.map(c => c.identifier);

        // ── Add distractors from other questions ──
        // Prefer same blank position, then fall back to any position
        const samePos = (distractorPool[i] || [])
          .filter(d => d.qIdx !== qIdx && !correctTexts.includes(d.text.toLowerCase()));
        const anyPos = Object.values(distractorPool).flat()
          .filter(d => d.qIdx !== qIdx && !correctTexts.includes(d.text.toLowerCase()));

        const usedTexts = new Set(correctTexts);
        const pickDistractors = (pool, count) => {
          const picked = [];
          // Shuffle pool for variety
          const shuffled = [...pool].sort(() => Math.random() - 0.5);
          for (const d of shuffled) {
            if (picked.length >= count) break;
            const key = d.text.toLowerCase();
            if (usedTexts.has(key)) continue;
            usedTexts.add(key);
            picked.push(d.text);
          }
          return picked;
        };

        // Try 2 from same-position pool first, then top up from any-position
        let distractors = pickDistractors(samePos, 2);
        if (distractors.length < 2) {
          distractors = distractors.concat(pickDistractors(anyPos, 2 - distractors.length));
        }

        for (const dText of distractors) {
          choices.push({ identifier: nanoid(), content: dText });
        }

        return {
          identifier: String(i + 1),
          response: {
            partialScoring: null,
            matchSimilarity: null,
            correctValues: correctIds,
            correctRanges: [],
            correctAreas: [],
            caseSensitive: false,
            errorMargin: null,
            baseType: null,
          },
          choiceInteraction: { choices },
        };
      });

    const logs = [];
    let created = 0, failed = 0;
    const questions = opts.questions;

    // ── Build distractor pool from all questions ──
    // Keyed by blank position (0, 1, …), each entry = { text, qIdx }
    const distractorPool = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      for (let bi = 0; bi < q.blanks.length; bi++) {
        if (!distractorPool[bi]) distractorPool[bi] = [];
        for (const ans of q.blanks[bi].answers) {
          distractorPool[bi].push({ text: ans, qIdx: qi });
        }
      }
    }

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      let prompt = q.prompt;
      const blankCount = (prompt.match(/___/g) || []).length;
      const expectedBlanks = q.blanks.length;

      // Handle duplicated prompts (QTI sometimes repeats the template text)
      // If we have more ___ markers than answer sets, trim the prompt to keep
      // only the first N blanks (the rest are duplicates)
      if (blankCount > expectedBlanks && expectedBlanks > 0) {
        let kept = 0;
        prompt = prompt.replace(/___/g, (match) => {
          kept++;
          return kept <= expectedBlanks ? '___' : '';
        });
        // Clean up leftover whitespace from removed markers
        prompt = prompt.replace(/\s{2,}/g, ' ').trim();
        logs.push({ msg: `Q${idx + 1}: trimmed duplicate blanks (${blankCount} → ${expectedBlanks})`, cls: 'warn' });
      } else if (blankCount < expectedBlanks) {
        logs.push({ msg: `Q${idx + 1}: ${blankCount} blank marker(s) but ${expectedBlanks} answer set(s) — skipped`, cls: 'warn' });
        failed++;
        continue;
      }

      const blankUUIDs = q.blanks.map(() => uuid());
      const shortPrompt = prompt.substring(0, 200);
      const promptDoc = buildPromptDoc(prompt, blankUUIDs);
      const fields = buildFields(q.blanks, distractorPool, idx);

      // Use per-blank points from XML, or override with UI value
      const pointsPerBlank = opts.points;
      const totalPoints = pointsPerBlank * q.blanks.length;

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'BLANKS',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: totalPoints,
          shuffle: opts.shuffle,
          promptDoc,
          fields,
        },
        childrenQuestions: [],
      };

      const res = await gql(CREATE_Q, variables, hdrs);
      if (res.errors?.length) {
        logs.push({ msg: `Q${idx + 1} failed: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        const cq = res?.data?.createQuestion;
        logs.push({ msg: `Q${idx + 1} created — #${cq?.libraryId} (${q.blanks.length} blank(s), ${totalPoints} pts)`, cls: 'ok' });
        created++;
      }
    }

    // Refresh library
    if (created > 0) await refreshLibrary();
    logs.push({ msg: `Import complete: ${created} created, ${failed} failed`, cls: created > 0 ? 'ok' : 'err' });

    return { success: failed === 0, processed: created, skipped: failed, logs };
  }

  // --- Import MCQ ---
  async function importMCQ(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'lecturer',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, failed = 0;
    const questions = opts.questions;

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const shortPrompt = q.prompt.substring(0, 200);
      const promptDoc = simplePromptDoc(q.prompt);

      // Build choices with identifiers
      const choices = q.choices.map(c => ({
        identifier: nanoid(),
        content: c.text,
      }));

      // Find correct choice identifiers
      const correctValues = [];
      q.choices.forEach((c, ci) => {
        if (c.correct) correctValues.push(choices[ci].identifier);
      });

      const fields = [{
        identifier: '1',
        response: {
          partialScoring: null,
          matchSimilarity: null,
          correctValues,
          correctRanges: [],
          correctAreas: [],
          caseSensitive: false,
          errorMargin: null,
          baseType: null,
        },
        choiceInteraction: {
          choices: choices.map(c => ({ identifier: c.identifier, content: c.content })),
          maxChoices: 1,
        },
      }];

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'MCQ',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: q.points || opts.points,
          shuffle: opts.shuffle,
          promptDoc,
          fields,
        },
        childrenQuestions: [],
      };

      const res = await gql(CREATE_Q, variables, hdrs);
      if (res.errors?.length) {
        logs.push({ msg: `MCQ Q${idx + 1} failed: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        const cq = res?.data?.createQuestion;
        logs.push({ msg: `MCQ Q${idx + 1} created — #${cq?.libraryId} (${q.choices.length} choices, ${q.points || opts.points} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (created > 0) await refreshLibrary();
    logs.push({ msg: `MCQ import complete: ${created} created, ${failed} failed`, cls: created > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created, skipped: failed, logs };
  }

  // --- Import Matching ---
  async function importMatching(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'lecturer',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, failed = 0;
    const questions = opts.questions;

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const shortPrompt = q.prompt.substring(0, 200);
      const promptDoc = simplePromptDoc(q.prompt);

      // Build source and target sets
      const sourceSet = q.pairs.map((p, i) => ({
        identifier: `source_${nanoid(8)}`,
        content: p.left,
      }));
      const targetSet = q.pairs.map((p, i) => ({
        identifier: `target_${nanoid(8)}`,
        content: p.right,
      }));

      // correctValues: target identifiers in order of sources
      const correctValues = targetSet.map(t => t.identifier);

      const totalPoints = (q.points || opts.points) * q.pairs.length;

      const fields = [{
        identifier: '1',
        response: {
          partialScoring: null,
          matchSimilarity: null,
          correctValues,
          correctRanges: [],
          correctAreas: [],
          caseSensitive: false,
          errorMargin: null,
          baseType: null,
        },
        matchInteraction: {
          sourceSet: sourceSet.map(s => ({ identifier: s.identifier, content: s.content })),
          targetSet: targetSet.map(t => ({ identifier: t.identifier, content: t.content })),
        },
      }];

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'MATCHING',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: totalPoints,
          shuffle: opts.shuffle,
          promptDoc,
          fields,
        },
        childrenQuestions: [],
      };

      const res = await gql(CREATE_Q, variables, hdrs);
      if (res.errors?.length) {
        logs.push({ msg: `Matching Q${idx + 1} failed: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        const cq = res?.data?.createQuestion;
        logs.push({ msg: `Matching Q${idx + 1} created — #${cq?.libraryId} (${q.pairs.length} pairs, ${totalPoints} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (created > 0) await refreshLibrary();
    logs.push({ msg: `Matching import complete: ${created} created, ${failed} failed`, cls: created > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created, skipped: failed, logs };
  }

  // --- Import Short Answer ---
  async function importShort(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'lecturer',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, failed = 0;
    const questions = opts.questions;
    const similarityFloat = (opts.similarity || 60) / 100;

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const shortPrompt = q.prompt.substring(0, 200);
      const promptDoc = simplePromptDoc(q.prompt);

      // correctValues are the answer strings themselves (not IDs)
      const correctValues = q.answers || [];

      const fields = [{
        identifier: '1',
        response: {
          partialScoring: null,
          matchSimilarity: similarityFloat,
          correctValues,
          correctRanges: [],
          correctAreas: [],
          caseSensitive: false,
          errorMargin: null,
          baseType: null,
        },
        textEntryInteraction: {
          expectedLength: null,
          attachmentEnabled: null,
        },
      }];

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'SHORT',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: q.points || opts.points,
          shuffle: false,
          promptDoc,
          fields,
        },
        childrenQuestions: [],
      };

      const res = await gql(CREATE_Q, variables, hdrs);
      if (res.errors?.length) {
        logs.push({ msg: `Short Q${idx + 1} failed: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        const cq = res?.data?.createQuestion;
        logs.push({ msg: `Short Q${idx + 1} created — #${cq?.libraryId} (${correctValues.length} answer(s), ${q.points || opts.points} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (created > 0) await refreshLibrary();
    logs.push({ msg: `Short answer import complete: ${created} created, ${failed} failed`, cls: created > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created, skipped: failed, logs };
  }

  // --- Dispatch ---
  const actions = { editMCQ, editMatching, editShort, deleteSelected, importFIB, importMCQ, importMatching, importShort };
  return actions[action](options);
}

// ── Parsers (popup context) ──────────────────────────────────────────────────

// Header aliases → internal keys (mirrors Python HEADER_MAP)
const HEADER_MAP = {
  '#': 'num', 'no': 'num', 'number': 'num',
  'type': 'type', 'question type': 'type',
  'question': 'question', 'question text': 'question',
  'bloom level': 'bloom', 'bloom': 'bloom', 'cognitive level': 'bloom',
  'difficulty': 'diff',
  'topic': 'topic', 'tags': 'topic', 'subject': 'topic',
  'answer / details': 'answers', 'answer/details': 'answers',
  'answers': 'answers', 'answer': 'answers', 'answer options': 'answers',
  'answer_options': 'answers', 'expected_answer': 'answers',
  'explanation': 'explanation', 'model answer': 'explanation',
  'source_file': 'source', 'source': 'source', 'source file': 'source',
};

let parsedByType = { fib: [], mcq: [], matching: [], short: [] };

// ── Type normalisation (mirrors cadmus_qti_generator.py normalise_type) ──────
function normaliseType(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (t === 'multiple choice' || t === 'mcq') return 'mcq';
  if (t.includes('fill in the blank') || t === 'fib') return 'fib';
  if (t === 'matching') return 'matching';
  if (t === 'short answer' || t === 'short response' || t === 'essay' || t === 'extended response') return 'short';
  return null;
}

// ── FIB helper: ceiling-division answer splitting ────────────────────────────
function splitFibAnswers(ansList, nBlanks) {
  if (nBlanks <= 1) return [ansList];
  const per = Math.ceil(ansList.length / nBlanks);
  const groups = [];
  for (let i = 0; i < nBlanks; i++) {
    groups.push(ansList.slice(i * per, Math.min((i + 1) * per, ansList.length)));
  }
  return groups;
}

// ── Excel multi-type parser ──────────────────────────────────────────────────
function parseExcelAll(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const result = { fib: [], mcq: [], matching: [], short: [] };
  if (!rows.length) return result;

  // Map headers to internal keys
  const rawHeaders = Object.keys(rows[0]);
  const colMap = {};
  for (const hdr of rawHeaders) {
    const key = HEADER_MAP[hdr.toLowerCase().trim()];
    if (key && !colMap[key]) colMap[key] = hdr;
  }

  for (const row of rows) {
    const get = (key) => String(row[colMap[key]] ?? '').trim();

    const num = get('num');
    const questionText = get('question');
    const type = get('type');
    const answersRaw = get('answers');
    const explanation = get('explanation');

    if (!num || !questionText) continue;

    const qType = normaliseType(type);
    if (!qType) continue;

    if (qType === 'fib') {
      // Count blanks from ___N___ markers
      const blankNums = [...questionText.matchAll(/___(\d+)___/g)].map(m => parseInt(m[1], 10));
      const nBlanks = blankNums.length ? Math.max(...blankNums) : 1;

      // Parse answers: semicolons separate individual answers
      const ansList = answersRaw.split(';').map(a => a.trim()).filter(Boolean);

      // Split across blanks using ceiling division (same as Python generator)
      const groups = splitFibAnswers(ansList, nBlanks);

      // Convert ___N___ markers to ___ for Cadmus promptDoc builder
      let prompt = questionText
        .replace(/___\d+___/g, '___')
        .replace(/\bTemplate:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Deduplicate repeated prompts
      const half = Math.floor(prompt.length / 2);
      const first = prompt.substring(0, half).trim();
      const second = prompt.substring(half).trim();
      if (first.length > 30 && first === second) {
        prompt = first;
      }

      result.fib.push({
        ident: `XLSX_Q${num}`,
        prompt,
        blanks: groups.map(g => ({ answers: g })),
        points: nBlanks,
        feedback: explanation || '',
        tags: get('topic') || '',
        source: get('source') || '',
      });

    } else if (qType === 'mcq') {
      // MCQ parsing: semicolons separate options, * prefix marks correct, OR last is correct
      const rawChoices = answersRaw.split(';').map(a => a.trim()).filter(Boolean);
      let hasStarMarker = rawChoices.some(c => c.startsWith('*'));
      const choices = rawChoices.map((c, ci) => {
        const isCorrect = hasStarMarker ? c.startsWith('*') : (ci === rawChoices.length - 1);
        const text = c.startsWith('*') ? c.substring(1).trim() : c;
        return { text, correct: isCorrect };
      });

      result.mcq.push({
        prompt: questionText,
        choices,
        points: 1,
        feedback: explanation || '',
      });

    } else if (qType === 'matching') {
      // Matching parsing: newlines with → separator for pairs (from answer_options column)
      const lines = answersRaw.split(/\n|\r\n?/).map(l => l.trim()).filter(Boolean);
      const pairs = [];
      for (const line of lines) {
        // Support both → and -> separators
        const sepIdx = line.indexOf('\u2192') !== -1 ? line.indexOf('\u2192') : line.indexOf('->');
        if (sepIdx === -1) continue;
        const sep = line.charAt(sepIdx) === '\u2192' ? '\u2192' : '->';
        const parts = line.split(sep);
        if (parts.length >= 2) {
          pairs.push({ left: parts[0].trim(), right: parts.slice(1).join(sep).trim() });
        }
      }

      if (pairs.length > 0) {
        result.matching.push({
          prompt: questionText,
          pairs,
          points: 1,
          feedback: explanation || '',
        });
      }

    } else if (qType === 'short') {
      // Short parsing: answer text → answers array, question text → prompt
      const answers = answersRaw.split(';').map(a => a.trim()).filter(Boolean);
      result.short.push({
        prompt: questionText,
        answers: answers.length > 0 ? answers : [explanation || ''],
        points: 1,
        feedback: explanation || '',
      });
    }
  }

  return result;
}

// ── QTI XML multi-type parser ────────────────────────────────────────────────
function parseQtiAll(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Handle namespace — QTI XML uses a default namespace
  const ns = doc.documentElement.namespaceURI || '';

  // Fallback: try both namespaced and non-namespaced
  const selAll = (el, tag) => {
    let nodes = el.getElementsByTagNameNS(ns, tag);
    if (!nodes.length) nodes = el.getElementsByTagName(tag);
    return nodes;
  };

  const items = selAll(doc, 'item');
  const result = { fib: [], mcq: [], matching: [], short: [] };

  for (const item of items) {
    try {
      // Detect type from bbmd_questiontype
      const typeNodes = selAll(item, 'bbmd_questiontype');
      const rawType = typeNodes.length ? typeNodes[0].textContent.trim() : '';

      // ── Get prompt text ──
      const fmtNodes = selAll(item, 'mat_formattedtext');
      if (!fmtNodes.length) continue;
      const rawHtml = fmtNodes[0].textContent;

      // Strip HTML, convert <br> to space, normalise whitespace
      const tmp = document.createElement('div');
      tmp.innerHTML = rawHtml.replace(/<br\s*\/?>/gi, ' ');

      // ── Get points ──
      const scoreNode = selAll(item, 'qmd_absolutescore_max');
      const maxScore = scoreNode.length ? parseFloat(scoreNode[0].textContent) : 2;

      // ── Get feedback ──
      let feedback = '';
      const fbNodes = selAll(item, 'itemfeedback');
      for (const fb of fbNodes) {
        if (fb.getAttribute('ident') === 'correct') {
          const fbText = selAll(fb, 'mat_formattedtext');
          if (fbText.length) {
            const fbTmp = document.createElement('div');
            fbTmp.innerHTML = fbText[0].textContent;
            feedback = fbTmp.textContent.trim();
          }
        }
      }

      // ── Get metadata ──
      const tagNode = selAll(item, 'bbmd_tags');
      const sourceNode = selAll(item, 'bbmd_source');

      // ── Route by type ──
      if (rawType === 'Multiple Choice') {
        // --- MCQ ---
        // Get choices from response_label elements
        const responseLids = selAll(item, 'response_lid');
        const choices = [];
        if (responseLids.length > 0) {
          const labels = selAll(responseLids[0], 'response_label');
          for (const label of labels) {
            const ident = label.getAttribute('ident') || '';
            const matText = selAll(label, 'mat_formattedtext');
            let content = '';
            if (matText.length) {
              const ctmp = document.createElement('div');
              ctmp.innerHTML = matText[0].textContent;
              content = ctmp.textContent.trim();
            }
            choices.push({ identifier: ident, text: content, correct: false });
          }
        }

        // Find correct answer from respcondition / varequal
        const respConditions = selAll(item, 'respcondition');
        for (const rc of respConditions) {
          const setVars = selAll(rc, 'setvar');
          // Look for the condition that adds score (correct answer)
          let isCorrectCondition = false;
          for (const sv of setVars) {
            const val = parseFloat(sv.textContent);
            if (val > 0) { isCorrectCondition = true; break; }
          }
          if (isCorrectCondition) {
            const varEquals = selAll(rc, 'varequal');
            for (const ve of varEquals) {
              const correctIdent = ve.textContent.trim();
              const match = choices.find(c => c.identifier === correctIdent);
              if (match) match.correct = true;
            }
          }
        }

        // If no correct was found, mark last as correct (fallback)
        if (!choices.some(c => c.correct) && choices.length > 0) {
          choices[choices.length - 1].correct = true;
        }

        let promptText = tmp.textContent.replace(/\s+/g, ' ').trim();

        result.mcq.push({
          prompt: promptText,
          choices: choices.map(c => ({ text: c.text, correct: c.correct })),
          points: maxScore,
          feedback,
        });

      } else if (rawType === 'Fill in the Blank' || rawType === 'Fill in the Blank Plus') {
        // --- FIB (existing logic) ---
        // Replace blank markers with ___ — handles both
        // <u>______</u> [blank N]  and  ______ [blank N]
        let promptText = tmp.textContent
          .replace(/_{2,}\s*\[blank\s*\d+\]/gi, '___')
          .replace(/\s+/g, ' ')
          .trim();

        // Deduplicate — some QTI items repeat the prompt twice
        const half = Math.floor(promptText.length / 2);
        const firstHalf = promptText.substring(0, half).trim();
        const secondHalf = promptText.substring(half).trim();
        if (firstHalf.length > 30 && firstHalf === secondHalf) {
          promptText = firstHalf;
        }

        // Get correct answers per blank
        const blanks = [];
        const respConditions = selAll(item, 'respcondition');
        for (const rc of respConditions) {
          const title = rc.getAttribute('title') || '';
          const blankMatch = title.match(/correct_blank_(\d+)/);
          if (!blankMatch) continue;
          const blankIdx = parseInt(blankMatch[1], 10) - 1;

          const varEquals = selAll(rc, 'varequal');
          const answers = [];
          for (const ve of varEquals) {
            const text = ve.textContent.trim();
            if (text) answers.push(text);
          }

          while (blanks.length <= blankIdx) blanks.push({ answers: [] });
          blanks[blankIdx].answers = answers;
        }

        if (!blanks.length) continue;

        result.fib.push({
          ident: item.getAttribute('ident') || '',
          prompt: promptText,
          blanks,
          points: maxScore,
          feedback,
          tags: tagNode.length ? tagNode[0].textContent.trim() : '',
          source: sourceNode.length ? sourceNode[0].textContent.trim() : '',
        });

      } else if (rawType === 'Matching') {
        // --- Matching ---
        let promptText = tmp.textContent.replace(/\s+/g, ' ').trim();

        // Parse pairs from response_lid elements
        const pairs = [];
        const responseLids = selAll(item, 'response_lid');

        // Build a map of right-side identifiers to their text
        const rightTextMap = {};
        for (const lid of responseLids) {
          const labels = selAll(lid, 'response_label');
          for (const label of labels) {
            const ident = label.getAttribute('ident') || '';
            if (ident.startsWith('right_') || ident.match(/^r\d+/i)) {
              const matText = selAll(label, 'mat_formattedtext');
              if (matText.length) {
                const ctmp = document.createElement('div');
                ctmp.innerHTML = matText[0].textContent;
                rightTextMap[ident] = ctmp.textContent.trim();
              }
            }
          }
        }

        // Build pairs: left text from response_lid with left_ ident, correct right from varequal
        const respConditions = selAll(item, 'respcondition');
        for (const lid of responseLids) {
          const lidIdent = lid.getAttribute('ident') || '';
          if (!lidIdent.match(/^left_/i) && !lidIdent.match(/^l\d+/i)) continue;

          // Get left text: first response_label's formatted text
          const labels = selAll(lid, 'response_label');
          let leftText = '';
          // The left text is typically the flow_label/material before choices
          // In BB QTI, left items have their text in the material element of flow_label
          const matNodes = selAll(lid, 'material');
          if (matNodes.length > 0) {
            const matFmt = selAll(matNodes[0], 'mat_formattedtext');
            if (matFmt.length) {
              const ltmp = document.createElement('div');
              ltmp.innerHTML = matFmt[0].textContent;
              leftText = ltmp.textContent.trim();
            }
          }

          // Find the correct right ident from respcondition
          let correctRightIdent = '';
          for (const rc of respConditions) {
            const varEquals = selAll(rc, 'varequal');
            for (const ve of varEquals) {
              const respIdent = ve.getAttribute('respident') || '';
              if (respIdent === lidIdent) {
                correctRightIdent = ve.textContent.trim();
                break;
              }
            }
            if (correctRightIdent) break;
          }

          const rightText = rightTextMap[correctRightIdent] || correctRightIdent;
          if (leftText && rightText) {
            pairs.push({ left: leftText, right: rightText });
          }
        }

        if (pairs.length > 0) {
          result.matching.push({
            prompt: promptText,
            pairs,
            points: maxScore,
            feedback,
          });
        }

      } else if (rawType === 'Short Response') {
        // --- Short Answer ---
        let promptText = tmp.textContent.replace(/\s+/g, ' ').trim();

        // Model answer from feedback
        const answers = [];
        if (feedback) answers.push(feedback);

        // Also check for varequal in respconditions for expected answers
        const respConditions = selAll(item, 'respcondition');
        for (const rc of respConditions) {
          const varEquals = selAll(rc, 'varequal');
          for (const ve of varEquals) {
            const text = ve.textContent.trim();
            if (text && !answers.includes(text)) answers.push(text);
          }
        }

        result.short.push({
          prompt: promptText,
          answers: answers.length > 0 ? answers : [''],
          points: maxScore,
          feedback,
        });
      }
    } catch (e) {
      console.warn('Skipped item:', e);
    }
  }

  return result;
}

// ── UI: Update badges and card states ────────────────────────────────────────
function updateImportUI() {
  const types = ['fib', 'mcq', 'matching', 'short'];
  for (const t of types) {
    const count = parsedByType[t].length;
    const badge = $(`#badge-${t}`);
    if (badge) badge.textContent = count;

    const card = $(`#card-${t}`);
    if (card) {
      if (count === 0) {
        card.classList.add('card--empty');
        card.removeAttribute('open');
      } else {
        card.classList.remove('card--empty');
      }
    }

    // Enable/disable import buttons
    const btn = card?.querySelector('[data-action]');
    if (btn) btn.disabled = count === 0;
  }

  // Update file summary
  const summary = $('#file-summary');
  if (summary) {
    const parts = [];
    if (parsedByType.fib.length) parts.push(`${parsedByType.fib.length} FIB`);
    if (parsedByType.mcq.length) parts.push(`${parsedByType.mcq.length} MCQ`);
    if (parsedByType.matching.length) parts.push(`${parsedByType.matching.length} Matching`);
    if (parsedByType.short.length) parts.push(`${parsedByType.short.length} Short`);
    summary.textContent = parts.length ? parts.join(' \u00b7 ') : '';
  }

  // Auto-open first non-empty card
  const firstNonEmpty = types.find(t => parsedByType[t].length > 0);
  if (firstNonEmpty) {
    const card = $(`#card-${firstNonEmpty}`);
    if (card && !card.hasAttribute('open')) card.setAttribute('open', '');
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t2 => t2.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  t.classList.add('active');
  document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
}));

// ── File input handler ───────────────────────────────────────────────────────
document.getElementById('import-file')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) {
    parsedByType = { fib: [], mcq: [], matching: [], short: [] };
    updateImportUI();
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'xml') {
    // QTI XML path
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        parsedByType = parseQtiAll(ev.target.result);
        updateImportUI();
        const total = parsedByType.fib.length + parsedByType.mcq.length + parsedByType.matching.length + parsedByType.short.length;
        log(`Parsed ${total} question(s) from ${file.name} (${parsedByType.fib.length} FIB, ${parsedByType.mcq.length} MCQ, ${parsedByType.matching.length} Matching, ${parsedByType.short.length} Short)`);
      } catch (err) {
        log(`XML parse error: ${err.message}`, 'err');
        parsedByType = { fib: [], mcq: [], matching: [], short: [] };
        updateImportUI();
      }
    };
    reader.readAsText(file);
  } else if (ext === 'xlsx' || ext === 'xls') {
    // Excel path
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        parsedByType = parseExcelAll(ev.target.result);
        updateImportUI();
        const total = parsedByType.fib.length + parsedByType.mcq.length + parsedByType.matching.length + parsedByType.short.length;
        log(`Parsed ${total} question(s) from ${file.name} (${parsedByType.fib.length} FIB, ${parsedByType.mcq.length} MCQ, ${parsedByType.matching.length} Matching, ${parsedByType.short.length} Short)`);
      } catch (err) {
        log(`Excel parse error: ${err.message}`, 'err');
        parsedByType = { fib: [], mcq: [], matching: [], short: [] };
        updateImportUI();
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    log(`Unsupported file type: .${ext} (use .xml or .xlsx)`, 'err');
  }
});

// ── Accordion: only one details open at a time per tab panel ─────────────────
document.querySelectorAll('.card[open]').forEach((d, i) => { if (i > 0) d.removeAttribute('open'); });
document.addEventListener('toggle', (e) => {
  if (e.target.tagName !== 'DETAILS' || !e.target.open) return;
  const panel = e.target.closest('.tab-panel');
  if (panel) {
    panel.querySelectorAll('details.card').forEach(d => {
      if (d !== e.target) d.removeAttribute('open');
    });
  }
}, true);

// ── Wire up buttons ──────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  let options = {};

  switch (action) {
    case 'editMCQ':
      options = { points: parseFloat($('#mcq-points').value), shuffle: $('#mcq-shuffle').checked };
      break;
    case 'editMatching':
      options = { points: parseFloat($('#match-points').value), shuffle: $('#match-shuffle').checked };
      break;
    case 'editShort':
      options = { points: parseFloat($('#short-points').value), similarity: parseInt($('#short-similarity').value, 10) };
      break;
    case 'deleteSelected':
      if (!confirm('Delete all selected questions? This cannot be undone.')) return;
      break;
    case 'importFIB':
      if (!parsedByType.fib.length) { log('No FIB questions loaded', 'err'); return; }
      options = {
        questions: parsedByType.fib,
        points: parseFloat($('#fib-points').value),
        shuffle: $('#fib-shuffle').checked,
      };
      break;
    case 'importMCQ':
      if (!parsedByType.mcq.length) { log('No MCQ questions loaded', 'err'); return; }
      options = {
        questions: parsedByType.mcq,
        points: parseFloat($('#mcq-import-points').value),
        shuffle: $('#mcq-import-shuffle').checked,
      };
      break;
    case 'importMatching':
      if (!parsedByType.matching.length) { log('No Matching questions loaded', 'err'); return; }
      options = {
        questions: parsedByType.matching,
        points: parseFloat($('#match-import-points').value),
        shuffle: $('#match-import-shuffle').checked,
      };
      break;
    case 'importShort':
      if (!parsedByType.short.length) { log('No Short Answer questions loaded', 'err'); return; }
      options = {
        questions: parsedByType.short,
        points: parseFloat($('#short-import-points').value),
        similarity: parseInt($('#short-import-similarity').value, 10),
      };
      break;
  }

  runAction(action, options);
});

// ── Init ─────────────────────────────────────────────────────────────────────
checkContext();
