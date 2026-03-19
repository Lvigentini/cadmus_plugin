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

// ── Check context on popup open ──────────────────────────────────────────────
async function checkContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setDisconnected('No active tab');

  const url = tab.url || '';
  const match = url.match(/cadmus\.io\/([^/]+)\/assessment\/([^/]+)\/library/);
  if (!match) return setDisconnected('Navigate to a Cadmus Question Library');

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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Disable all buttons while running
  document.querySelectorAll('.btn').forEach(b => b.disabled = true);
  log(`Running ${action}…`);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
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
    const asmtRes = await gql(
      `query GetAssessment($assessmentId: ID!) {
         assessment(assessmentId: $assessmentId) { id subjectId }
       }`,
      { assessmentId },
      hdrs
    );
    const subjectId = asmtRes?.data?.assessment?.subjectId;
    if (!subjectId) return { error: 'Could not fetch subjectId' };

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

    // Helpers
    const uuid = () => crypto.randomUUID();
    const nanoid = (len = 21) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      return Array.from(bytes, b => chars[b % chars.length]).join('');
    };

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

  // --- Dispatch ---
  const actions = { editMCQ, editMatching, editShort, deleteSelected, importFIB };
  return actions[action](options);
}

// ── QTI XML Parser ───────────────────────────────────────────────────────────
let parsedQuestions = [];

function parseQtiXml(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Handle namespace — QTI XML uses a default namespace
  const ns = doc.documentElement.namespaceURI || '';
  const sel = (el, tag) => ns
    ? el.getElementsByTagNameNS(ns, tag)
    : el.getElementsByTagName(tag);

  // Fallback: try both namespaced and non-namespaced
  const selAll = (el, tag) => {
    let nodes = el.getElementsByTagNameNS(ns, tag);
    if (!nodes.length) nodes = el.getElementsByTagName(tag);
    return nodes;
  };

  const items = selAll(doc, 'item');
  const questions = [];

  for (const item of items) {
    try {
      // ── Get prompt text ──
      const fmtNodes = selAll(item, 'mat_formattedtext');
      if (!fmtNodes.length) continue;
      const rawHtml = fmtNodes[0].textContent;

      // Strip HTML, convert <br> to space, normalise whitespace
      const tmp = document.createElement('div');
      tmp.innerHTML = rawHtml.replace(/<br\s*\/?>/gi, ' ');

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

      // ── Get points ──
      const scoreNode = selAll(item, 'qmd_absolutescore_max');
      const maxScore = scoreNode.length ? parseFloat(scoreNode[0].textContent) : 2;

      // ── Get correct answers per blank ──
      const blanks = [];
      const respConditions = selAll(item, 'respcondition');
      for (const rc of respConditions) {
        const title = rc.getAttribute('title') || '';
        const blankMatch = title.match(/correct_blank_(\d+)/);
        if (!blankMatch) continue;
        const blankIdx = parseInt(blankMatch[1], 10) - 1; // 0-based

        const varEquals = selAll(rc, 'varequal');
        const answers = [];
        for (const ve of varEquals) {
          const text = ve.textContent.trim();
          if (text) answers.push(text);
        }

        // Ensure blanks array is large enough
        while (blanks.length <= blankIdx) blanks.push({ answers: [] });
        blanks[blankIdx].answers = answers;
      }

      if (!blanks.length) continue;

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

      questions.push({
        ident: item.getAttribute('ident') || '',
        prompt: promptText,
        blanks,
        points: maxScore,
        feedback,
        tags: tagNode.length ? tagNode[0].textContent.trim() : '',
        source: sourceNode.length ? sourceNode[0].textContent.trim() : '',
      });
    } catch (e) {
      console.warn('Skipped item:', e);
    }
  }

  return questions;
}

function updatePreview(questions) {
  const preview = $('#fib-preview');
  const btn = $('[data-action="importFIB"]');

  if (!questions.length) {
    preview.innerHTML = '';
    btn.textContent = 'Import 0 questions';
    btn.disabled = true;
    return;
  }

  let html = `<div class="q-count">${questions.length} question(s) parsed</div>`;
  const shown = questions.slice(0, 5);
  for (const q of shown) {
    const blankCount = q.blanks.length;
    const short = q.prompt.length > 60 ? q.prompt.substring(0, 57) + '…' : q.prompt;
    html += `<div class="q-item">${blankCount} blank(s) — ${short}</div>`;
  }
  if (questions.length > 5) {
    html += `<div class="q-item">… and ${questions.length - 5} more</div>`;
  }
  preview.innerHTML = html;
  btn.textContent = `Import ${questions.length} questions`;
  btn.disabled = false;
}

// ── Excel Parser (matches cadmus_qti_generator.py logic) ─────────────────────

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

function splitFibAnswers(ansList, nBlanks) {
  // Ceiling division — mirrors Python's split_fib_answers
  if (nBlanks <= 1) return [ansList];
  const per = Math.ceil(ansList.length / nBlanks);
  const groups = [];
  for (let i = 0; i < nBlanks; i++) {
    groups.push(ansList.slice(i * per, Math.min((i + 1) * per, ansList.length)));
  }
  return groups;
}

function parseExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (!rows.length) return [];

  // Map headers to internal keys
  const rawHeaders = Object.keys(rows[0]);
  const colMap = {};
  for (const hdr of rawHeaders) {
    const key = HEADER_MAP[hdr.toLowerCase().trim()];
    if (key && !colMap[key]) colMap[key] = hdr;
  }

  const questions = [];
  for (const row of rows) {
    const get = (key) => String(row[colMap[key]] ?? '').trim();

    const num = get('num');
    const questionText = get('question');
    const type = get('type');
    const answersRaw = get('answers');

    if (!num || !questionText) continue;

    // Only process fill-in-blank types
    const tLower = type.toLowerCase();
    const isFib = tLower.includes('fill in the blank') || tLower.includes('fib');
    if (!isFib) continue;

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

    // Deduplicate repeated prompts (some rows repeat the text)
    const half = Math.floor(prompt.length / 2);
    const first = prompt.substring(0, half).trim();
    const second = prompt.substring(half).trim();
    if (first.length > 30 && first === second) {
      prompt = first;
    }

    questions.push({
      ident: `XLSX_Q${num}`,
      prompt,
      blanks: groups.map(g => ({ answers: g })),
      points: nBlanks, // 1 pt per blank default
      feedback: get('explanation') || '',
      tags: get('topic') || '',
      source: get('source') || '',
    });
  }

  return questions;
}

// ── File input handler ───────────────────────────────────────────────────────
document.getElementById('fib-file')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) { parsedQuestions = []; updatePreview([]); return; }

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'xml') {
    // QTI XML path
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        parsedQuestions = parseQtiXml(ev.target.result);
        updatePreview(parsedQuestions);
        log(`Parsed ${parsedQuestions.length} fill-in-blank question(s) from ${file.name}`);
      } catch (err) {
        log(`XML parse error: ${err.message}`, 'err');
        parsedQuestions = [];
        updatePreview([]);
      }
    };
    reader.readAsText(file);
  } else if (ext === 'xlsx' || ext === 'xls') {
    // Excel path
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        parsedQuestions = parseExcel(ev.target.result);
        updatePreview(parsedQuestions);
        log(`Parsed ${parsedQuestions.length} fill-in-blank question(s) from ${file.name}`);
      } catch (err) {
        log(`Excel parse error: ${err.message}`, 'err');
        parsedQuestions = [];
        updatePreview([]);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    log(`Unsupported file type: .${ext} (use .xml or .xlsx)`, 'err');
  }
});

// ── Accordion: only one details open at a time ──────────────────────────────
document.querySelectorAll('.card[open]').forEach((d, i) => { if (i > 0) d.removeAttribute('open'); });
document.addEventListener('toggle', (e) => {
  if (e.target.tagName !== 'DETAILS' || !e.target.open) return;
  document.querySelectorAll('details.card').forEach(d => {
    if (d !== e.target) d.removeAttribute('open');
  });
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
      if (!parsedQuestions.length) { log('No questions loaded', 'err'); return; }
      options = {
        questions: parsedQuestions,
        points: parseFloat($('#fib-points').value),
        shuffle: $('#fib-shuffle').checked,
      };
      break;
  }

  runAction(action, options);
});

// ── Init ─────────────────────────────────────────────────────────────────────
checkContext();
