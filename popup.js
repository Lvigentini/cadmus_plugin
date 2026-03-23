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
  $('#status-text').textContent = `Connected — ${tenant} / ${assessmentId.substring(0, 8)}…`;
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
async function runAction(action, options, { silent = false } = {}) {
  if (!cadmusTabId) {
    log('No Cadmus tab found — refresh and try again', 'err');
    return null;
  }

  // Disable all buttons while running
  document.querySelectorAll('.btn').forEach(b => b.disabled = true);
  if (!silent) log(`Running ${action}…`);

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
      return null;
    }
    if (result.error) {
      log(result.error, 'err');
      return result;
    }
    // Show per-item logs
    if (!silent && result.logs) {
      result.logs.forEach(l => log(l.msg, l.cls));
    }
    if (!silent && result.success) {
      log(`Done — ${result.processed} processed, ${result.skipped} skipped`, 'ok');
    }
    return result;
  } catch (err) {
    log(`Error: ${err.message}`, 'err');
    return null;
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

  // Build a lightweight index of all questions currently in the library
  // Uses TanStack table data — no GraphQL calls needed
  function fetchLibraryIndex() {
    const table = findTanStackTable();
    if (!table) return [];
    return table.getRowModel().rows.map(r => ({
      id: r.original.id,
      type: r.original.questionType,
      prompt: (r.original.shortPrompt || '').trim(),
    }));
  }

  // Jaccard word-overlap similarity (0–1)
  function jaccardSimilarity(textA, textB) {
    const tokenise = t => new Set(t.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
    const setA = tokenise(textA);
    const setB = tokenise(textB);
    if (!setA.size || !setB.size) return 0;
    let intersection = 0;
    for (const w of setA) { if (setB.has(w)) intersection++; }
    return intersection / (setA.size + setB.size - intersection);
  }

  // Find best matching existing question using Jaccard similarity (threshold 0.7)
  function findExistingQuestion(index, questionType, promptText) {
    if (!promptText?.trim()) return null;
    let best = null, bestScore = 0;
    for (const q of index) {
      if (q.type !== questionType) continue;
      const score = jaccardSimilarity(promptText, q.prompt);
      if (score >= 0.7 && score > bestScore) {
        best = q;
        bestScore = score;
      }
    }
    return best ? { ...best, similarity: bestScore } : null;
  }

  // Scan all incoming questions against the library and return matches
  function scanDuplicates(opts) {
    const index = fetchLibraryIndex();
    if (!index.length) return { matches: [] };
    const matches = [];
    for (const q of (opts.questions || [])) {
      const match = findExistingQuestion(index, q.type, q.prompt);
      if (match) {
        matches.push({
          globalIdx: q.globalIdx,
          type: q.type,
          incomingPrompt: q.prompt.substring(0, 200),
          existingId: match.id,
          existingPrompt: match.prompt.substring(0, 200),
          similarity: Math.round(match.similarity * 100),
        });
      }
    }
    return { matches };
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
    updateQuestionAttributes(questionIds: $questionIds, input: $input) { id points difficulty }
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

  const APPEND_TAGS = `mutation AppendTagsForQuestions($questionIds: [ID!]!, $input: [TagInput!]!) {
    appendTagsForQuestions(questionIds: $questionIds, input: $input) { id }
  }`;

  async function tagQuestions(questionIds, tagName, hdrs) {
    if (!questionIds.length || !tagName) return null;
    return gql(APPEND_TAGS, {
      questionIds,
      input: [{ categoryId: "1", name: tagName }],
    }, hdrs);
  }

  async function setDifficulty(questionIds, difficulty, hdrs) {
    if (!questionIds.length || !difficulty) return null;
    return gql(ATTRS_MUT, {
      questionIds,
      input: { difficulty },
    }, hdrs);
  }

  // ── Shared post-import: tags (from columns), bloom tags, difficulty ─────────
  async function applyPostImportMeta(createdIds, hdrs, logs, typeLabel) {
    if (!createdIds.length) return;

    // 1. Column-based tags — each item has tags: ['val1', 'val2', ...]
    const tagGroups = {};
    for (const c of createdIds) {
      for (const t of (c.tags || [])) {
        const key = t.trim();
        if (!key) continue;
        if (!tagGroups[key]) tagGroups[key] = [];
        tagGroups[key].push(c.id);
      }
    }
    for (const [tag, ids] of Object.entries(tagGroups)) {
      const tagRes = await tagQuestions(ids, tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Tag "${tag}" failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${ids.length} ${typeLabel}(s) with "${tag}"`, cls: 'ok' });
    }

    // 2. Bloom-level tags
    const bloomGroups = {};
    for (const c of createdIds) {
      if (c.bloom) {
        const key = `bloom-${c.bloom.toLowerCase().trim()}`;
        if (!bloomGroups[key]) bloomGroups[key] = [];
        bloomGroups[key].push(c.id);
      }
    }
    for (const [tag, ids] of Object.entries(bloomGroups)) {
      const tagRes = await tagQuestions(ids, tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Bloom tagging failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${ids.length} ${typeLabel}(s) with "${tag}"`, cls: 'ok' });
    }

    // 3. Difficulty
    const diffGroups = {};
    for (const c of createdIds) {
      if (c.difficulty) {
        if (!diffGroups[c.difficulty]) diffGroups[c.difficulty] = [];
        diffGroups[c.difficulty].push(c.id);
      }
    }
    for (const [diff, ids] of Object.entries(diffGroups)) {
      const res = await setDifficulty(ids, diff, hdrs);
      if (res?.errors) logs.push({ msg: `Difficulty failed: ${res.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Set ${ids.length} ${typeLabel}(s) to ${diff}`, cls: 'ok' });
    }
  }

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
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId, 'x-cadmus-url': window.location.href };
    const sel = getSelectedRows();
    if (sel.error) return sel;
    const { rows } = sel;

    const logs = [];
    let errors = 0;
    for (const row of rows) {
      const { id, shortPrompt } = row.original;
      const d = await gql(ARCHIVE_Q, { questionId: id }, hdrs);
      if (d.errors) { logs.push({ msg: `Failed: ${shortPrompt?.substring(0, 50) || id} — ${d.errors[0]?.message || 'unknown error'}`, cls: 'err' }); errors++; }
      else logs.push({ msg: `Deleted: ${shortPrompt?.substring(0, 50) || id}`, cls: 'ok' });
    }

    await refreshLibrary();
    return { success: errors === 0, processed: rows.length - errors, skipped: 0, logs };
  }

  // --- Import Fill-in-Blank (BLANKS type) ---
  async function importFIB(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'AUTHOR',
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
    let created = 0, updated = 0, failed = 0;
    const createdIds = [];  // { id, bloom }
    const questions = opts.questions;

    // ── Duplicate detection: scan existing library ──
    const libIndex = fetchLibraryIndex();

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
      if (blankCount > expectedBlanks && expectedBlanks > 0) {
        let kept = 0;
        prompt = prompt.replace(/___/g, (match) => {
          kept++;
          return kept <= expectedBlanks ? '___' : '';
        });
        prompt = prompt.replace(/\s{2,}/g, ' ').trim();
        logs.push({ msg: `Q${idx + 1}: trimmed duplicate blanks (${blankCount} → ${expectedBlanks})`, cls: 'warn' });
      } else if (blankCount < expectedBlanks) {
        logs.push({ msg: `Q${idx + 1}: found ${blankCount} ___ marker(s) in prompt but ${expectedBlanks} answer group(s) — add ___N___ placeholders to the question text or reduce answer groups`, cls: 'warn' });
        failed++;
        continue;
      }

      const blankUUIDs = q.blanks.map(() => uuid());
      const shortPrompt = prompt.substring(0, 200);
      const promptDoc = buildPromptDoc(prompt, blankUUIDs);
      const fields = buildFields(q.blanks, distractorPool, idx);

      const pointsPerBlank = opts.points;
      const totalPoints = pointsPerBlank * q.blanks.length;

      // ── Check resolution map for duplicates ──
      const globalIdx = (opts.globalIdxOffset || 0) + idx;
      const resolution = opts.resolutions?.[globalIdx];
      if (resolution === 'skip') {
        logs.push({ msg: `Q${idx + 1} skipped (user chose skip)`, cls: 'warn' });
        continue;
      }
      if (resolution === 'update') {
        const existing = findExistingQuestion(libIndex, 'BLANKS', prompt);
        if (existing) {
          const fd = await gql(FETCH_Q, { questionId: existing.id }, hdrs);
          if (fd.errors) { logs.push({ msg: `Q${idx + 1} update fetch failed`, cls: 'err' }); failed++; continue; }
          const eq = fd.data.question;
          const input = {
            id: eq.id,
            attributes: {
              promptDoc: eq.body.promptDoc, questionType: eq.questionType, shortPrompt: eq.shortPrompt,
              feedback: q.feedback || eq.body.feedback, promptImage: null, parentQuestionId: eq.parentQuestionId,
              points: totalPoints, shuffle: opts.shuffle, fields,
            },
          };
          const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
          if (ud.errors) { logs.push({ msg: `Q${idx + 1} update failed: ${ud.errors[0].message}`, cls: 'err' }); failed++; }
          else {
            createdIds.push({ id: eq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
            logs.push({ msg: `Q${idx + 1} updated — ${eq.shortPrompt?.substring(0, 40)} (${q.blanks.length} blank(s))`, cls: 'ok' });
            updated++;
          }
          continue;
        }
      }

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
        if (cq?.id) createdIds.push({ id: cq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
        logs.push({ msg: `Q${idx + 1} created — #${cq?.libraryId} (${q.blanks.length} blank(s), ${totalPoints} pts)`, cls: 'ok' });
        created++;
      }
    }

    // Tag with filename
    if (createdIds.length && opts.tag) {
      const allIds = createdIds.map(c => c.id);
      const tagRes = await tagQuestions(allIds, opts.tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Tagging failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${allIds.length} question(s) with "${opts.tag}"`, cls: 'ok' });
    }

    // Tag with column tags + bloom + difficulty
    await applyPostImportMeta(createdIds, hdrs, logs, 'FIB');

    // Refresh library
    if (created > 0 || updated > 0) await refreshLibrary();
    logs.push({ msg: `Import complete: ${created} created, ${updated} updated, ${failed} failed`, cls: (created + updated) > 0 ? 'ok' : 'err' });

    return { success: failed === 0, processed: created + updated, skipped: failed, logs };
  }

  // --- Import MCQ ---
  async function importMCQ(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'AUTHOR',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, updated = 0, failed = 0;
    const createdIds = [];
    const questions = opts.questions;

    // ── Duplicate detection ──
    const libIndex = fetchLibraryIndex();

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

      // ── Check resolution map for duplicates ──
      const globalIdx = (opts.globalIdxOffset || 0) + idx;
      const resolution = opts.resolutions?.[globalIdx];
      if (resolution === 'skip') { logs.push({ msg: `MCQ Q${idx + 1} skipped (user chose skip)`, cls: 'warn' }); continue; }
      if (resolution === 'update') {
        const existing = findExistingQuestion(libIndex, 'MCQ', q.prompt);
        if (existing) {
          const fd = await gql(FETCH_Q, { questionId: existing.id }, hdrs);
          if (fd.errors) { logs.push({ msg: `MCQ Q${idx + 1} update fetch failed`, cls: 'err' }); failed++; continue; }
          const eq = fd.data.question;
          const input = {
            id: eq.id,
            attributes: {
              promptDoc: eq.body.promptDoc, questionType: eq.questionType, shortPrompt: eq.shortPrompt,
              feedback: q.feedback || eq.body.feedback, promptImage: null, parentQuestionId: eq.parentQuestionId,
              points: opts.points, shuffle: opts.shuffle, fields,
            },
          };
          const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
          if (ud.errors) { logs.push({ msg: `MCQ Q${idx + 1} update failed: ${ud.errors[0].message}`, cls: 'err' }); failed++; }
          else {
            createdIds.push({ id: eq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
            logs.push({ msg: `MCQ Q${idx + 1} updated — ${eq.shortPrompt?.substring(0, 40)} (${q.choices.length} choices)`, cls: 'ok' });
            updated++;
          }
          continue;
        }
      }

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'MCQ',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: opts.points,
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
        if (cq?.id) createdIds.push({ id: cq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
        logs.push({ msg: `MCQ Q${idx + 1} created — #${cq?.libraryId} (${q.choices.length} choices, ${opts.points} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (createdIds.length && opts.tag) {
      const allIds = createdIds.map(c => c.id);
      const tagRes = await tagQuestions(allIds, opts.tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Tagging failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${allIds.length} MCQ(s) with "${opts.tag}"`, cls: 'ok' });
    }

    // Tag with column tags + bloom + difficulty
    await applyPostImportMeta(createdIds, hdrs, logs, 'MCQ');

    if (created > 0 || updated > 0) await refreshLibrary();
    logs.push({ msg: `MCQ import complete: ${created} created, ${updated} updated, ${failed} failed`, cls: (created + updated) > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created, skipped: failed, logs };
  }

  // --- Import Matching ---
  async function importMatching(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'AUTHOR',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, updated = 0, failed = 0;
    const createdIds = [];
    const questions = opts.questions;

    // ── Duplicate detection ──
    const libIndex = fetchLibraryIndex();

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const shortPrompt = q.prompt.substring(0, 200);
      const promptDoc = simplePromptDoc(q.prompt);

      // Build source and target sets (correct pairs)
      // No explicit distractors needed — in matching questions all targets
      // are visible to students at once, so each target naturally serves
      // as a distractor for every other prompt
      const sourceSet = q.pairs.map((p, i) => ({
        identifier: `source_${nanoid(8)}`,
        content: p.left,
      }));
      const targetSet = q.pairs.map((p, i) => ({
        identifier: `target_${nanoid(8)}`,
        content: p.right,
      }));

      // correctValues: space-separated "sourceId targetId" pairs
      const correctValues = sourceSet.map((s, i) => `${s.identifier} ${targetSet[i].identifier}`);

      const totalPoints = opts.points * q.pairs.length;

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

      // ── Check resolution map for duplicates ──
      const globalIdx = (opts.globalIdxOffset || 0) + idx;
      const resolution = opts.resolutions?.[globalIdx];
      if (resolution === 'skip') { logs.push({ msg: `Matching Q${idx + 1} skipped (user chose skip)`, cls: 'warn' }); continue; }
      if (resolution === 'update') {
        const existing = findExistingQuestion(libIndex, 'MATCHING', q.prompt);
        if (existing) {
          const fd = await gql(FETCH_Q, { questionId: existing.id }, hdrs);
          if (fd.errors) { logs.push({ msg: `Matching Q${idx + 1} update fetch failed`, cls: 'err' }); failed++; continue; }
          const eq = fd.data.question;
          const eqField = eq.body?.fields?.[0];
          const eqInter = eqField?.interaction;

          // Rebuild using the existing question's identifiers where possible,
          // or create new ones if pair count changed
          const updSourceSet = q.pairs.map((p, pi) => ({
            identifier: eqInter?.sourceSet?.[pi]?.identifier || `source_${nanoid(8)}`,
            content: p.left,
          }));
          const updTargetSet = q.pairs.map((p, pi) => ({
            identifier: eqInter?.targetSet?.[pi]?.identifier || `target_${nanoid(8)}`,
            content: p.right,
          }));
          // Clean correctValues — no distractors, just source→target pairs
          const updCorrectValues = updSourceSet.map((s, pi) => `${s.identifier} ${updTargetSet[pi].identifier}`);

          const updFields = [{
            identifier: eqField?.identifier || '1',
            response: {
              partialScoring: null, matchSimilarity: null,
              correctValues: updCorrectValues,
              correctRanges: [], correctAreas: [], caseSensitive: false, errorMargin: null, baseType: null,
            },
            matchInteraction: {
              sourceSet: updSourceSet.map(s => ({ identifier: s.identifier, content: s.content })),
              targetSet: updTargetSet.map(t => ({ identifier: t.identifier, content: t.content })),
            },
          }];

          const input = {
            id: eq.id,
            attributes: {
              promptDoc: eq.body.promptDoc, questionType: eq.questionType, shortPrompt: eq.shortPrompt,
              feedback: q.feedback || eq.body.feedback, promptImage: null, parentQuestionId: eq.parentQuestionId,
              points: totalPoints, shuffle: opts.shuffle, fields: updFields,
            },
          };
          const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
          if (ud.errors) { logs.push({ msg: `Matching Q${idx + 1} update failed: ${ud.errors[0].message}`, cls: 'err' }); failed++; }
          else {
            createdIds.push({ id: eq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
            logs.push({ msg: `Matching Q${idx + 1} updated — ${eq.shortPrompt?.substring(0, 40)} (${q.pairs.length} pairs, distractors stripped)`, cls: 'ok' });
            updated++;
          }
          continue;
        }
      }

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
        if (cq?.id) createdIds.push({ id: cq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
        logs.push({ msg: `Matching Q${idx + 1} created — #${cq?.libraryId} (${q.pairs.length} pairs, ${totalPoints} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (createdIds.length && opts.tag) {
      const allIds = createdIds.map(c => c.id);
      const tagRes = await tagQuestions(allIds, opts.tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Tagging failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${allIds.length} Matching question(s) with "${opts.tag}"`, cls: 'ok' });
    }

    // Tag with column tags + bloom + difficulty
    await applyPostImportMeta(createdIds, hdrs, logs, 'Matching');

    if (created > 0 || updated > 0) await refreshLibrary();
    logs.push({ msg: `Matching import complete: ${created} created, ${updated} updated, ${failed} failed`, cls: (created + updated) > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created + updated, skipped: failed, logs };
  }

  // --- Import Short Answer ---
  async function importShort(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = {
      'x-cadmus-role': 'AUTHOR',
      'x-cadmus-tenant': tenant,
      'x-cadmus-assessment': assessmentId,
      'x-cadmus-url': window.location.href,
    };

    const subjectId = await fetchSubjectId(assessmentId, hdrs);
    if (!subjectId) return { error: 'Could not fetch subjectId' };

    const logs = [];
    let created = 0, updated = 0, failed = 0;
    const createdIds = [];
    const questions = opts.questions;
    const similarityFloat = (opts.similarity || 60) / 100;

    // ── Duplicate detection ──
    const libIndex = fetchLibraryIndex();

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

      // ── Check resolution map for duplicates ──
      const globalIdx = (opts.globalIdxOffset || 0) + idx;
      const resolution = opts.resolutions?.[globalIdx];
      if (resolution === 'skip') { logs.push({ msg: `Short Q${idx + 1} skipped (user chose skip)`, cls: 'warn' }); continue; }
      if (resolution === 'update') {
        const existing = findExistingQuestion(libIndex, 'SHORT', q.prompt);
        if (existing) {
          const fd = await gql(FETCH_Q, { questionId: existing.id }, hdrs);
          if (fd.errors) { logs.push({ msg: `Short Q${idx + 1} update fetch failed`, cls: 'err' }); failed++; continue; }
          const eq = fd.data.question;
          const input = {
            id: eq.id,
            attributes: {
              promptDoc: eq.body.promptDoc, questionType: eq.questionType, shortPrompt: eq.shortPrompt,
              feedback: q.feedback || eq.body.feedback, promptImage: null, parentQuestionId: eq.parentQuestionId,
              points: opts.points, shuffle: false, fields,
            },
          };
          const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
          if (ud.errors) { logs.push({ msg: `Short Q${idx + 1} update failed: ${ud.errors[0].message}`, cls: 'err' }); failed++; }
          else {
            createdIds.push({ id: eq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
            logs.push({ msg: `Short Q${idx + 1} updated — ${eq.shortPrompt?.substring(0, 40)} (${correctValues.length} answer(s))`, cls: 'ok' });
            updated++;
          }
          continue;
        }
      }

      const variables = {
        assessmentId,
        subjectId,
        input: {
          questionType: 'SHORT',
          shortPrompt,
          feedback: q.feedback || '',
          promptImage: null,
          parentQuestionId: null,
          points: opts.points,
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
        if (cq?.id) createdIds.push({ id: cq.id, tags: q.tags || [], bloom: q.bloom || '', difficulty: q.difficulty || '' });
        logs.push({ msg: `Short Q${idx + 1} created — #${cq?.libraryId} (${correctValues.length} answer(s), ${opts.points} pts)`, cls: 'ok' });
        created++;
      }
    }

    if (createdIds.length && opts.tag) {
      const allIds = createdIds.map(c => c.id);
      const tagRes = await tagQuestions(allIds, opts.tag, hdrs);
      if (tagRes?.errors) logs.push({ msg: `Tagging failed: ${tagRes.errors[0].message}`, cls: 'warn' });
      else logs.push({ msg: `Tagged ${allIds.length} Short question(s) with "${opts.tag}"`, cls: 'ok' });
    }

    // Tag with column tags + bloom + difficulty
    await applyPostImportMeta(createdIds, hdrs, logs, 'Short');

    if (created > 0 || updated > 0) await refreshLibrary();
    logs.push({ msg: `Short answer import complete: ${created} created, ${updated} updated, ${failed} failed`, cls: (created + updated) > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: created + updated, skipped: failed, logs };
  }

  // --- Fix Matching Questions (repair correctValues + add distractors) ---
  async function fixMatchingQuestions(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };

    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };

    // Get matching questions — selected or all
    let rows;
    const selected = table.getSelectedRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    if (selected.length > 0) {
      rows = selected;
    } else {
      // No selection — fix all matching questions in the library
      rows = table.getRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    }
    if (!rows.length) return { error: 'No matching questions found in the library' };

    const logs = [];
    let fixed = 0, skipped = 0, failed = 0;

    // Fetch all matching questions
    const fetchedQuestions = [];
    for (let i = 0; i < rows.length; i++) {
      const qId = rows[i].original.id;
      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) {
        logs.push({ msg: `Fetch failed for ${rows[i].original.shortPrompt?.substring(0, 40) || qId}`, cls: 'err' });
        failed++;
        continue;
      }
      fetchedQuestions.push(fd.data.question);
    }

    // Fix each question: repair correctValues and strip stale distractors
    // No explicit distractors needed — in matching questions all targets are
    // visible to students at once, so each target naturally serves as a
    // distractor for every other prompt
    for (const q of fetchedQuestions) {
      const field = q.body?.fields?.[0];
      const inter = field?.interaction;
      if (!inter?.sourceSet || !inter?.targetSet) {
        logs.push({ msg: `Skipped ${q.shortPrompt?.substring(0, 40)} — no match interaction`, cls: 'warn' });
        skipped++;
        continue;
      }

      const sourceSet = inter.sourceSet;
      const originalTargetSet = inter.targetSet;
      const cv = field.response?.correctValues || [];

      // Check if correctValues are broken (no space = bare target IDs)
      const needsRepair = cv.length === 0 || cv.some(v => !v.includes(' '));

      // Also check for stale distractors that shouldn't be there
      const correctTargetIds = new Set();
      if (!needsRepair) {
        for (const v of cv) { const parts = v.split(' '); if (parts[1]) correctTargetIds.add(parts[1]); }
      } else {
        sourceSet.forEach((_, i) => { if (originalTargetSet[i]) correctTargetIds.add(originalTargetSet[i].identifier); });
      }
      const hasStaleDistractors = originalTargetSet.some(t => !correctTargetIds.has(t.identifier));

      if (!needsRepair && !hasStaleDistractors) {
        logs.push({ msg: `${q.shortPrompt?.substring(0, 40)} — already correct, skipped`, cls: 'ok' });
        skipped++;
        continue;
      }

      // Rebuild correctValues as "sourceId targetId" pairs
      let newCorrectValues;
      if (needsRepair) {
        newCorrectValues = sourceSet.map((s, i) => {
          const t = originalTargetSet[i];
          return t ? `${s.identifier} ${t.identifier}` : null;
        }).filter(Boolean);
      } else {
        newCorrectValues = cv;
      }

      // Keep only correct targets (strip any distractors)
      const cleanTargetSet = originalTargetSet.filter(t => correctTargetIds.has(t.identifier));

      // Update the question
      const input = {
        id: q.id,
        attributes: {
          promptDoc: q.body.promptDoc, questionType: q.questionType, shortPrompt: q.shortPrompt,
          feedback: q.body.feedback, promptImage: null, parentQuestionId: q.parentQuestionId,
          points: q.points, shuffle: q.shuffle,
          fields: [{
            identifier: field.identifier,
            response: {
              partialScoring: field.response.partialScoring, matchSimilarity: null,
              correctValues: newCorrectValues,
              correctRanges: [], correctAreas: [], caseSensitive: field.response.caseSensitive, errorMargin: null, baseType: null,
            },
            matchInteraction: {
              sourceSet: sourceSet.map(s => ({ identifier: s.identifier, content: s.content })),
              targetSet: cleanTargetSet.map(t => ({ identifier: t.identifier, content: t.content })),
            },
          }],
        },
      };

      const ud = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (ud.errors) {
        logs.push({ msg: `Update failed for ${q.shortPrompt?.substring(0, 40)}: ${ud.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        const removedCount = originalTargetSet.length - cleanTargetSet.length;
        const parts = [];
        if (needsRepair) parts.push(`repaired ${newCorrectValues.length} pairings`);
        if (removedCount > 0) parts.push(`removed ${removedCount} stale distractor(s)`);
        logs.push({ msg: `Fixed ${q.shortPrompt?.substring(0, 40)} — ${parts.join(', ')}`, cls: 'ok' });
        fixed++;
      }
    }

    if (fixed > 0) await refreshLibrary();
    logs.push({ msg: `Fix complete: ${fixed} repaired, ${skipped} skipped, ${failed} failed`, cls: fixed > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: fixed, skipped, logs };
  }

  // --- Export questions ---
  async function exportQuestions(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };

    // Get rows based on scope
    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };

    let rows;
    if (opts.scope === 'all') {
      // Get ALL rows from table (not just selected)
      rows = table.getRowModel().rows;
    } else {
      rows = table.getSelectedRowModel().rows;
    }
    if (!rows.length) return { error: opts.scope === 'all' ? 'No questions in library' : 'No questions selected. Select rows using the checkboxes first.' };

    const logs = [];
    const questions = [];

    // Fetch full data for each question via GraphQL
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const orig = row.original || {};
      const qId = orig.id;

      // Report progress back — the popup will display this
      if (typeof opts._onProgress === 'function') opts._onProgress(i + 1, rows.length);

      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) {
        logs.push({ msg: `Fetch failed for ${orig.shortPrompt?.substring(0, 40) || qId}`, cls: 'err' });
        continue;
      }

      const q = fd.data.question;
      const field = q.body?.fields?.[0];
      const inter = field?.interaction;

      // Extract plain text from ProseMirror JSON promptDoc
      let promptText = q.shortPrompt || '';
      try {
        const doc = typeof q.body.promptDoc === 'string' ? JSON.parse(q.body.promptDoc) : q.body.promptDoc;
        if (doc?.content) {
          const texts = [];
          const walk = (nodes) => {
            for (const n of nodes) {
              if (n.type === 'text' && n.text) texts.push(n.text);
              else if (n.type === 'blankInline') texts.push('___');
              else if (n.type === 'paragraph' && texts.length) texts.push('\n');
              if (n.content) walk(n.content);
            }
          };
          walk(doc.content);
          promptText = texts.join('').trim() || promptText;
        }
      } catch (_) { /* keep shortPrompt */ }

      // Build normalised question object
      const qObj = {
        index: i + 1,
        id: q.id,
        questionType: q.questionType,
        prompt: promptText,
        feedback: q.body?.feedback || '',
        points: q.points ?? 1,
        shuffle: q.shuffle ?? false,
        difficulty: orig.difficulty || '',
        tags: (orig.tags || []).map(t => typeof t === 'string' ? t : (t.name || '')),
        // Scoring
        correctValues: field?.response?.correctValues || [],
        matchSimilarity: field?.response?.matchSimilarity,
        caseSensitive: field?.response?.caseSensitive,
      };

      // Type-specific data
      if (inter?.__typename === 'ChoiceInteraction') {
        qObj.choices = (inter.choices || []).map(c => ({
          identifier: c.identifier,
          text: c.content,
          correct: (field.response?.correctValues || []).includes(c.identifier),
        }));
        qObj.maxChoices = inter.maxChoices;
      } else if (inter?.__typename === 'MatchInteraction') {
        qObj.sourceSet = (inter.sourceSet || []).map(s => ({ identifier: s.identifier, content: s.content }));
        qObj.targetSet = (inter.targetSet || []).map(t => ({ identifier: t.identifier, content: t.content }));
        // Build pairs from correctValues — format is "sourceId targetId"
        qObj.pairs = [];
        for (const cv of (field.response?.correctValues || [])) {
          const parts = cv.split(' ');
          if (parts.length === 2) {
            const src = qObj.sourceSet.find(s => s.identifier === parts[0]);
            const tgt = qObj.targetSet.find(t => t.identifier === parts[1]);
            if (src && tgt) qObj.pairs.push({ left: src.content, right: tgt.content });
          }
        }
      } else if (inter?.__typename === 'TextEntryInteraction') {
        qObj.expectedLength = inter.expectedLength;
        qObj.attachmentEnabled = inter.attachmentEnabled;
      }

      questions.push(qObj);
    }

    logs.push({ msg: `Fetched ${questions.length} of ${rows.length} question(s)`, cls: 'ok' });
    return {
      success: true,
      questions,
      source: window.location.href,
      exportedAt: new Date().toISOString(),
      logs,
    };
  }

  // --- Dispatch ---
  const actions = { editMCQ, editMatching, editShort, deleteSelected, importFIB, importMCQ, importMatching, importShort, exportQuestions, fixMatchingQuestions, scanDuplicates };
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
let importFileName = '';
let pendingExcelRows = null;   // raw rows from XLSX, held until mapping is confirmed
let pendingExcelHeaders = [];  // raw header names from the spreadsheet

// ── Internal field definitions for column mapping ────────────────────────────
const INTERNAL_FIELDS = [
  { key: 'num',         label: '#',           required: true },
  { key: 'type',        label: 'Type',        required: true },
  { key: 'question',    label: 'Question',    required: true },
  { key: 'answers',     label: 'Answers',     required: true },
  { key: 'explanation', label: 'Explanation',  required: false },
  { key: 'bloom',       label: 'Bloom Level', required: false },
  { key: 'diff',        label: 'Difficulty',  required: false },
];

// Columns that should be auto-checked as tag sources
const AUTO_TAG_KEYS = ['topic', 'tags', 'subject', 'source', 'source file', 'source_file'];

// ── Build mapping UI ─────────────────────────────────────────────────────────
function showColumnMapping(headers, rows) {
  // Auto-detect initial mapping using HEADER_MAP
  const autoMap = {};
  for (const hdr of headers) {
    const key = HEADER_MAP[hdr.toLowerCase().trim()];
    if (key && !autoMap[key]) autoMap[key] = hdr;
  }

  const container = $('#mapping-rows');
  container.innerHTML = '';

  // ── Single-select field dropdowns ──
  for (const field of INTERNAL_FIELDS) {
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = field.label;
    if (field.required) {
      const req = document.createElement('span');
      req.className = 'field-required';
      req.textContent = ' *';
      label.appendChild(req);
    }

    const select = document.createElement('select');
    select.dataset.field = field.key;

    const optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = '— unmapped —';
    select.appendChild(optNone);

    for (const hdr of headers) {
      const opt = document.createElement('option');
      opt.value = hdr;
      opt.textContent = hdr;
      if (autoMap[field.key] === hdr) opt.selected = true;
      select.appendChild(opt);
    }

    select.className = select.value ? 'mapped' : 'unmapped';
    select.addEventListener('change', () => {
      select.className = select.value ? 'mapped' : 'unmapped';
      const sampleEl = row.querySelector('.sample-val');
      if (sampleEl) {
        sampleEl.textContent = select.value ? String(rows[0]?.[select.value] ?? '').substring(0, 40) : '';
      }
    });

    const sample = document.createElement('span');
    sample.className = 'sample-val';
    sample.textContent = autoMap[field.key] ? String(rows[0]?.[autoMap[field.key]] ?? '').substring(0, 40) : '';

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(sample);
    container.appendChild(row);
  }

  // ── Multi-select tag columns ──
  const tagSection = document.createElement('div');
  tagSection.className = 'mapping-tag-section';

  const tagLabel = document.createElement('div');
  tagLabel.className = 'mapping-tag-label';
  tagLabel.innerHTML = '<span class="field-label" style="text-align:left">Tag columns</span>'
    + '<span class="mapping-hint">Each checked column\'s values will be applied as tags to imported questions</span>';
  tagSection.appendChild(tagLabel);

  const tagGrid = document.createElement('div');
  tagGrid.className = 'mapping-tag-grid';
  tagGrid.id = 'mapping-tag-checkboxes';

  // Columns already mapped to internal fields — no point showing as tag options
  const mappedCols = new Set(Object.values(autoMap).map(v => v.toLowerCase().trim()));

  for (const hdr of headers) {
    // Skip columns that are already mapped to internal fields (#, Type, Question, etc.)
    if (mappedCols.has(hdr.toLowerCase().trim())) continue;

    const lbl = document.createElement('label');
    lbl.className = 'mapping-tag-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = hdr;
    cb.dataset.tagCol = hdr;

    // Auto-check columns that match known tag-like headers
    const hdrLower = hdr.toLowerCase().trim();
    if (AUTO_TAG_KEYS.includes(hdrLower)) cb.checked = true;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'mapping-tag-name';
    nameSpan.textContent = hdr;

    // Collect unique values from the first 5 rows as preview
    const seen = new Set();
    const preview = [];
    for (let ri = 0; ri < Math.min(5, rows.length); ri++) {
      const val = String(rows[ri]?.[hdr] ?? '').trim();
      if (val && !seen.has(val.toLowerCase())) {
        seen.add(val.toLowerCase());
        preview.push(val.length > 25 ? val.substring(0, 25) + '…' : val);
      }
    }
    const sampleSpan = document.createElement('span');
    sampleSpan.className = 'mapping-tag-sample';
    sampleSpan.textContent = preview.length ? `(${preview.join(', ')})` : '';

    lbl.appendChild(cb);
    lbl.appendChild(nameSpan);
    lbl.appendChild(sampleSpan);
    tagGrid.appendChild(lbl);
  }

  tagSection.appendChild(tagGrid);
  container.appendChild(tagSection);

  $('#column-mapping').style.display = '';
}

function hideColumnMapping() {
  $('#column-mapping').style.display = 'none';
  $('#mapping-rows').innerHTML = '';
}

// ── Duplicate review panel ───────────────────────────────────────────────────
let pendingDuplicateMatches = [];

function showDuplicateReview(matches) {
  pendingDuplicateMatches = matches;
  const container = $('#review-rows');
  container.innerHTML = '';

  for (const m of matches) {
    const row = document.createElement('div');
    row.className = 'review-row';
    row.dataset.idx = m.globalIdx;
    row.innerHTML = `
      <div class="review-col">
        <span class="review-label">New (importing)</span>
        <span class="review-type">${m.type}</span>
        <p class="review-prompt">${escHtml(m.incomingPrompt)}</p>
      </div>
      <div class="review-similarity">${m.similarity}%</div>
      <div class="review-col">
        <span class="review-label">Existing (in library)</span>
        <span class="review-type">${m.type}</span>
        <p class="review-prompt">${escHtml(m.existingPrompt)}</p>
      </div>
      <div class="review-actions">
        <label><input type="radio" name="dup-${m.globalIdx}" value="update" checked> Update existing</label>
        <label><input type="radio" name="dup-${m.globalIdx}" value="create"> Create new</label>
        <label><input type="radio" name="dup-${m.globalIdx}" value="skip"> Skip</label>
      </div>
    `;
    container.appendChild(row);
  }

  $('#duplicate-review').style.display = '';
}

function hideDuplicateReview() {
  $('#duplicate-review').style.display = 'none';
  $('#review-rows').innerHTML = '';
  pendingDuplicateMatches = [];
}

function getDuplicateResolutions() {
  const resolutions = {};
  for (const m of pendingDuplicateMatches) {
    const sel = document.querySelector(`input[name="dup-${m.globalIdx}"]:checked`);
    resolutions[m.globalIdx] = sel?.value || 'create';
  }
  return resolutions;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

async function executeImport(resolutions) {
  const tag = importFileName || '';
  const jobs = [];

  // Track global index offsets for each type
  let offset = 0;
  if (parsedByType.fib.length) {
    jobs.push(['importFIB', {
      questions: parsedByType.fib,
      points: parseFloat($('#fib-points').value),
      shuffle: isToggleOn('fib-shuffle'),
      tag, resolutions, globalIdxOffset: offset,
    }]);
    offset += parsedByType.fib.length;
  }
  if (parsedByType.mcq.length) {
    jobs.push(['importMCQ', {
      questions: parsedByType.mcq,
      points: parseFloat($('#mcq-import-points').value),
      shuffle: isToggleOn('mcq-import-shuffle'),
      tag, resolutions, globalIdxOffset: offset,
    }]);
    offset += parsedByType.mcq.length;
  }
  if (parsedByType.matching.length) {
    jobs.push(['importMatching', {
      questions: parsedByType.matching,
      points: parseFloat($('#match-import-points').value),
      shuffle: isToggleOn('match-import-shuffle'),
      tag, resolutions, globalIdxOffset: offset,
    }]);
    offset += parsedByType.matching.length;
  }
  if (parsedByType.short.length) {
    jobs.push(['importShort', {
      questions: parsedByType.short,
      points: parseFloat($('#short-import-points').value),
      similarity: parseInt($('#short-import-similarity').value, 10),
      tag, resolutions, globalIdxOffset: offset,
    }]);
  }
  for (const [act, opts] of jobs) {
    await runAction(act, opts);
  }
}

// ── Read user's column mapping from the UI ───────────────────────────────────
function getUserColumnMap() {
  const map = {};
  document.querySelectorAll('#mapping-rows select').forEach(sel => {
    if (sel.value) map[sel.dataset.field] = sel.value;
  });
  return map;
}

function getUserTagColumns() {
  const cols = [];
  document.querySelectorAll('#mapping-tag-checkboxes input[type="checkbox"]:checked').forEach(cb => {
    cols.push(cb.value);
  });
  return cols;
}

// ── Type normalisation (mirrors cadmus_qti_generator.py normalise_type) ──────
function normaliseType(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (t === 'multiple choice' || t === 'mcq') return 'mcq';
  if (t.includes('fill in the blank') || t === 'fib') return 'fib';
  if (t === 'matching') return 'matching';
  if (t === 'short answer' || t === 'short response' || t === 'essay' || t === 'extended response') return 'short';
  return null;
}

// ── Difficulty normaliser → EASY | MEDIUM | HARD or '' ───────────────────────
function normaliseDifficulty(raw) {
  // Strip decorative chars (●, ★, •, etc.) and whitespace, then match keyword
  const d = (raw || '').replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase().trim();
  if (!d) return '';
  if (d.includes('easy') || d === '1' || d.includes('low')) return 'EASY';
  if (d.includes('medium') || d === '2' || d.includes('moderate') || d === 'med') return 'MEDIUM';
  if (d.includes('hard') || d === '3' || d.includes('high') || d.includes('difficult')) return 'HARD';
  return '';
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
// customColMap: optional { internalKey: 'Excel Column Name' } override
// tagColumns: optional array of Excel column names whose values become tags
function parseExcelAll(rows, customColMap, tagColumns) {
  const result = { fib: [], mcq: [], matching: [], short: [] };
  if (!rows.length) return result;

  // Use custom map if provided, otherwise auto-detect from HEADER_MAP
  let colMap;
  if (customColMap) {
    colMap = customColMap;
  } else {
    const rawHeaders = Object.keys(rows[0]);
    colMap = {};
    for (const hdr of rawHeaders) {
      const key = HEADER_MAP[hdr.toLowerCase().trim()];
      if (key && !colMap[key]) colMap[key] = hdr;
    }
  }

  // Tag columns to collect — defaults to topic column if no explicit list
  const tagCols = tagColumns || (colMap.topic ? [colMap.topic] : []);

  for (const row of rows) {
    const get = (key) => String(row[colMap[key]] ?? '').trim();

    // Collect tags from all checked tag columns
    const tags = [];
    for (const col of tagCols) {
      const val = String(row[col] ?? '').trim();
      if (val) tags.push(val);
    }

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

      // If no blank markers exist, append one (single-blank FIB)
      if (!(prompt.includes('___'))) {
        prompt += ' ___';
      }

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
        tags,
        source: get('source') || '',
        bloom: get('bloom') || '',
        difficulty: normaliseDifficulty(get('diff')),
      });

    } else if (qType === 'mcq') {
      // MCQ parsing: split by newlines or semicolons (whichever yields more choices)
      const bySemicolon = answersRaw.split(';').map(a => a.trim()).filter(Boolean);
      const byNewline = answersRaw.split(/\r?\n/).map(a => a.trim()).filter(Boolean);
      const rawChoices = byNewline.length > bySemicolon.length ? byNewline : bySemicolon;

      // Detect correct-answer markers: * prefix, ✓ suffix, or ✔ suffix
      let hasStarMarker = rawChoices.some(c => c.startsWith('*'));
      const hasCheckMark = rawChoices.some(c => /[✓✔]/.test(c));

      const choices = rawChoices.map((c, ci) => {
        let text = c;
        let isCorrect = false;

        // Strip leading letter labels (A. B. C. D. etc.)
        text = text.replace(/^[A-Za-z][.)]\s*/, '');

        if (hasStarMarker) {
          isCorrect = text.startsWith('*');
          if (isCorrect) text = text.substring(1).trim();
        } else if (hasCheckMark) {
          isCorrect = /[✓✔]/.test(text);
          text = text.replace(/[✓✔]/g, '').trim();
        } else {
          // Fallback: last choice is correct
          isCorrect = (ci === rawChoices.length - 1);
        }

        return { text, correct: isCorrect };
      });

      result.mcq.push({
        prompt: questionText,
        choices,
        feedback: explanation || '',
        tags,
        bloom: get('bloom') || '',
        difficulty: normaliseDifficulty(get('diff')),
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
          feedback: explanation || '',
          topic: get('topic') || '',
          bloom: get('bloom') || '',
          difficulty: normaliseDifficulty(get('diff')),
        });
      }

    } else if (qType === 'short') {
      // Short parsing: answer text → answers array, question text → prompt
      const answers = answersRaw.split(';').map(a => a.trim()).filter(Boolean);
      result.short.push({
        prompt: questionText,
        answers: answers.length > 0 ? answers : [explanation || ''],
        feedback: explanation || '',
        tags,
        bloom: get('bloom') || '',
        difficulty: normaliseDifficulty(get('diff')),
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

    // No per-type import buttons anymore
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

  // Enable/disable the single Import All button
  const total = types.reduce((s, t) => s + parsedByType[t].length, 0);
  const importAllBtn = $('#btn-import-all');
  if (importAllBtn) importAllBtn.disabled = total === 0;
}

// ── Export format converters ─────────────────────────────────────────────────

function formatAnswerDetails(q) {
  switch (q.questionType) {
    case 'MCQ':
      if (!q.choices?.length) return '';
      return q.choices.map((c, i) => {
        const label = String.fromCharCode(65 + i);
        return `${label}. ${c.text}${c.correct ? ' \u2713' : ''}`;
      }).join('\n');
    case 'MATCHING':
      if (!q.pairs?.length) return '';
      return q.pairs.map(p => `${p.left} \u2192 ${p.right}`).join('\n');
    case 'BLANKS':
      return (q.correctValues || []).join('; ');
    case 'SHORT':
      return (q.correctValues || []).join('; ');
    default:
      return (q.correctValues || []).join('; ');
  }
}

function exportToExcel(data) {
  const headers = ['#', 'Type', 'Question', 'Answer / Details', 'Explanation', 'Difficulty', 'Points', 'Tags'];
  const rows = [headers];
  for (const q of data.questions) {
    rows.push([
      q.index,
      q.questionType,
      q.prompt,
      formatAnswerDetails(q),
      q.feedback || '',
      q.difficulty || '',
      q.points ?? '',
      (q.tags || []).join(', '),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 4 }, { wch: 12 }, { wch: 60 }, { wch: 45 }, { wch: 40 }, { wch: 10 }, { wch: 7 }, { wch: 25 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Questions');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

function exportToCsv(data) {
  const esc = (v) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const headers = ['#', 'Type', 'Question', 'Answer / Details', 'Explanation', 'Difficulty', 'Points', 'Tags'];
  const lines = [headers.map(esc).join(',')];
  for (const q of data.questions) {
    lines.push([
      q.index,
      q.questionType,
      q.prompt,
      formatAnswerDetails(q),
      q.feedback || '',
      q.difficulty || '',
      q.points ?? '',
      (q.tags || []).join('; '),
    ].map(esc).join(','));
  }
  return lines.join('\r\n');
}

function exportToJson(data) {
  return JSON.stringify({
    exportedAt: data.exportedAt,
    exportVersion: '2.0',
    source: data.source,
    totalQuestions: data.questions.length,
    questions: data.questions,
  }, null, 2);
}

function exportToQti(data) {
  const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function choiceItem(q) {
    const ident = `q_${q.index}`;
    const choices = (q.choices || []).map((c, i) => {
      const cid = String.fromCharCode(65 + i);
      return `        <response_label ident="${cid}"><flow_mat><material><mattext texttype="text/html">${escXml(c.text)}</mattext></material></flow_mat></response_label>`;
    }).join('\n');
    const correctIds = (q.choices || []).filter(c => c.correct).map((_, i) => String.fromCharCode(65 + i));
    const cardinality = correctIds.length > 1 ? 'Multiple' : 'Single';
    const respConditions = correctIds.map(cid =>
      `      <respcondition title="correct"><conditionvar><varequal respident="response" case="No">${cid}</varequal></conditionvar><setvar variablename="SCORE" action="Set">SCORE.max</setvar></respcondition>`
    ).join('\n');

    return `  <item ident="${ident}" maxattempts="0">
    <itemmetadata><bbmd_asi_object_id>${ident}</bbmd_asi_object_id><bbmd_questiontype>Multiple Choice</bbmd_questiontype><qmd_absolutescore_max>${q.points ?? 1}</qmd_absolutescore_max></itemmetadata>
    <presentation><flow class="Block"><flow class="QUESTION_BLOCK"><flow class="FORMATTED_TEXT_BLOCK"><material><mattext texttype="text/html">${escXml(q.prompt)}</mattext></material></flow></flow>
      <flow class="RESPONSE_BLOCK"><response_lid ident="response" rcardinality="${cardinality}" rtiming="No"><render_choice shuffle="No" minnumber="0" maxnumber="0">
${choices}
      </render_choice></response_lid></flow>
    </flow></presentation>
    <resprocessing scoremodel="SumOfScores"><outcomes><decvar varname="SCORE" vartype="Integer" defaultval="0" minvalue="0" maxvalue="${q.points ?? 1}"/></outcomes>
${respConditions}
      <respcondition title="incorrect"><conditionvar><other/></conditionvar><setvar variablename="SCORE" action="Set">0</setvar></respcondition>
    </resprocessing>
    ${q.feedback ? `<itemfeedback ident="correct" view="All"><flow_mat><material><mattext texttype="text/html">${escXml(q.feedback)}</mattext></material></flow_mat></itemfeedback>` : ''}
  </item>`;
  }

  function fibItem(q) {
    const ident = `q_${q.index}`;
    const answers = q.correctValues || [];
    const respConditions = answers.map(a =>
      `      <respcondition><conditionvar><varequal respident="response" case="No">${escXml(a)}</varequal></conditionvar><setvar variablename="SCORE" action="Set">SCORE.max</setvar></respcondition>`
    ).join('\n');
    const typeLabel = q.questionType === 'MATCHING' ? 'Short Response' : 'Short Response';

    // For matching, embed pairs in the prompt
    let fullPrompt = q.prompt;
    if (q.questionType === 'MATCHING' && q.pairs?.length) {
      fullPrompt += '\n\nMatch the following:\n' + q.pairs.map(p => `${p.left} \u2192 ${p.right}`).join('\n');
    }

    return `  <item ident="${ident}" maxattempts="0">
    <itemmetadata><bbmd_asi_object_id>${ident}</bbmd_asi_object_id><bbmd_questiontype>${typeLabel}</bbmd_questiontype><qmd_absolutescore_max>${q.points ?? 1}</qmd_absolutescore_max></itemmetadata>
    <presentation><flow class="Block"><flow class="QUESTION_BLOCK"><flow class="FORMATTED_TEXT_BLOCK"><material><mattext texttype="text/html">${escXml(fullPrompt)}</mattext></material></flow></flow>
      <flow class="RESPONSE_BLOCK"><response_str ident="response" rcardinality="Single" rtiming="No"><render_fib><response_label ident="answer1"/></render_fib></response_str></flow>
    </flow></presentation>
    <resprocessing scoremodel="SumOfScores"><outcomes><decvar varname="SCORE" vartype="Integer" defaultval="0" minvalue="0" maxvalue="${q.points ?? 1}"/></outcomes>
${respConditions}
      <respcondition title="incorrect"><conditionvar><other/></conditionvar><setvar variablename="SCORE" action="Set">0</setvar></respcondition>
    </resprocessing>
    ${q.feedback ? `<itemfeedback ident="correct" view="All"><flow_mat><material><mattext texttype="text/html">${escXml(q.feedback)}</mattext></material></flow_mat></itemfeedback>` : ''}
  </item>`;
  }

  const items = data.questions.map(q => {
    if (q.questionType === 'MCQ') return choiceItem(q);
    return fibItem(q);
  }).join('\n\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2">
  <assessment ident="cadmus_export" title="Cadmus Question Export">
    <section ident="root_section">
${items}
    </section>
  </assessment>
</questestinterop>`;
}

function downloadFile(content, filename, mimeType) {
  const blob = content instanceof ArrayBuffer || content instanceof Uint8Array
    ? new Blob([content], { type: mimeType })
    : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    importFileName = '';
    pendingExcelRows = null;
    pendingExcelHeaders = [];
    hideColumnMapping();
    updateImportUI();
    return;
  }

  // Store filename without extension for tagging
  importFileName = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'xml') {
    // QTI XML path — no column mapping needed
    hideColumnMapping();
    pendingExcelRows = null;
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
    // Excel path — show column mapping first
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!rows.length) {
          log('Excel file has no data rows', 'warn');
          return;
        }
        pendingExcelRows = rows;
        pendingExcelHeaders = Object.keys(rows[0]);
        showColumnMapping(pendingExcelHeaders, rows);
        // Reset parsed data until mapping is confirmed
        parsedByType = { fib: [], mcq: [], matching: [], short: [] };
        updateImportUI();
        log(`Loaded ${rows.length} row(s) from ${file.name} — verify column mapping below, then click "Apply Mapping & Parse"`);
      } catch (err) {
        log(`Excel read error: ${err.message}`, 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    log(`Unsupported file type: .${ext} (use .xml or .xlsx)`, 'err');
  }
});

// ── Apply column mapping button ──────────────────────────────────────────────
document.getElementById('btn-apply-mapping')?.addEventListener('click', () => {
  if (!pendingExcelRows?.length) return;

  const colMap = getUserColumnMap();
  const tagCols = getUserTagColumns();

  // Validate required fields
  const missing = INTERNAL_FIELDS.filter(f => f.required && !colMap[f.key]);
  if (missing.length) {
    log(`Missing required mappings: ${missing.map(f => f.label).join(', ')}`, 'err');
    return;
  }

  try {
    parsedByType = parseExcelAll(pendingExcelRows, colMap, tagCols);
    updateImportUI();
    const total = parsedByType.fib.length + parsedByType.mcq.length + parsedByType.matching.length + parsedByType.short.length;
    const tagInfo = tagCols.length ? ` — tagging from: ${tagCols.join(', ')}` : '';
    log(`Parsed ${total} question(s) (${parsedByType.fib.length} FIB, ${parsedByType.mcq.length} MCQ, ${parsedByType.matching.length} Matching, ${parsedByType.short.length} Short)${tagInfo}`);
    hideColumnMapping();
  } catch (err) {
    log(`Parse error: ${err.message}`, 'err');
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

// ── Toggle switch behaviour ──────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('.toggle');
  if (!toggle) return;
  const isActive = toggle.classList.toggle('active');
  toggle.setAttribute('aria-pressed', isActive);
  toggle.querySelector('.toggle-label-text').textContent = isActive ? 'On' : 'Off';
});

// Helper: read toggle state
const isToggleOn = (id) => document.getElementById(id)?.classList.contains('active') ?? false;

// ── Wire up buttons ──────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  let options = {};

  switch (action) {
    case 'editMCQ':
      options = { points: parseFloat($('#mcq-points').value), shuffle: isToggleOn('mcq-shuffle') };
      break;
    case 'editMatching':
      options = { points: parseFloat($('#match-points').value), shuffle: isToggleOn('match-shuffle') };
      break;
    case 'fixMatching':
      // Fix matching questions — repair correctValues + add cross-question distractors
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Fixing matching questions — repairing correct answer pairings and adding distractors…');
        const result = await runAction('fixMatchingQuestions', {});
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'editShort':
      options = { points: parseFloat($('#short-points').value), similarity: parseInt($('#short-similarity').value, 10) };
      break;
    case 'deleteSelected':
      if (!confirm('Delete all selected questions? This cannot be undone.')) return;
      break;
    case 'exportQuestions':
      // Export flow: fetch data in page context → convert in popup context → download
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        const fmt = $('#export-format').value;
        const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'selected';
        const progress = $('#export-progress');
        if (progress) { progress.style.display = 'block'; progress.textContent = 'Fetching question data\u2026'; }
        log(`Exporting ${scope} questions as ${fmt.toUpperCase()}\u2026`);

        const result = await runAction('exportQuestions', { scope });
        if (progress) progress.style.display = 'none';

        if (!result || result.error) {
          document.querySelectorAll('.btn').forEach(b => b.disabled = false);
          return; // runAction already logged the error
        }

        const data = result;
        if (!data.questions?.length) {
          log('No questions to export', 'err');
          document.querySelectorAll('.btn').forEach(b => b.disabled = false);
          return;
        }

        // Build filename
        const ts = new Date().toISOString().slice(0, 10);
        const baseName = `cadmus_export_${ts}`;

        try {
          switch (fmt) {
            case 'xlsx': {
              const buf = exportToExcel(data);
              downloadFile(buf, `${baseName}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
              break;
            }
            case 'csv': {
              const csv = exportToCsv(data);
              downloadFile(csv, `${baseName}.csv`, 'text/csv');
              break;
            }
            case 'json': {
              const json = exportToJson(data);
              downloadFile(json, `${baseName}.json`, 'application/json');
              break;
            }
            case 'qti': {
              const xml = exportToQti(data);
              downloadFile(xml, `${baseName}.xml`, 'application/xml');
              break;
            }
          }
          log(`Exported ${data.questions.length} question(s) as ${baseName}.${fmt === 'qti' ? 'xml' : fmt}`, 'ok');
        } catch (err) {
          log(`Export failed: ${err.message}`, 'err');
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'importAll':
      // Scan for duplicates, then either show review panel or import directly
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Scanning library for duplicates…');

        // Build flat question list with global indices
        let globalIdx = 0;
        const scanList = [];
        for (const q of parsedByType.fib)      scanList.push({ globalIdx: globalIdx++, type: 'BLANKS', prompt: q.prompt });
        for (const q of parsedByType.mcq)      scanList.push({ globalIdx: globalIdx++, type: 'MCQ', prompt: q.prompt });
        for (const q of parsedByType.matching)  scanList.push({ globalIdx: globalIdx++, type: 'MATCHING', prompt: q.prompt });
        for (const q of parsedByType.short)     scanList.push({ globalIdx: globalIdx++, type: 'SHORT', prompt: q.prompt });

        const scanResult = await runAction('scanDuplicates', { questions: scanList }, { silent: true });
        const matches = scanResult?.matches || [];

        if (matches.length > 0) {
          // Show duplicate review panel
          showDuplicateReview(matches);
          document.querySelectorAll('.btn').forEach(b => b.disabled = false);
          log(`Found ${matches.length} potential duplicate(s) — review before importing`, 'warn');
        } else {
          // No duplicates — import directly
          log('No duplicates found — importing…');
          await executeImport({});
          document.querySelectorAll('.btn').forEach(b => b.disabled = false);
          updateImportUI();
        }
      })();
      return; // skip the runAction below
  }

  runAction(action, options);
});

// ── Per-type import buttons ──────────────────────────────────────────────────
document.querySelectorAll('.btn--import-type').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.importType;
    if (!parsedByType[type]?.length) { log(`No ${type} questions parsed`, 'warn'); return; }

    document.querySelectorAll('.btn').forEach(b => b.disabled = true);
    const tag = importFileName || '';
    const typeMap = {
      fib:      ['importFIB',      { questions: parsedByType.fib, points: parseFloat($('#fib-points').value), shuffle: isToggleOn('fib-shuffle'), tag }],
      mcq:      ['importMCQ',      { questions: parsedByType.mcq, points: parseFloat($('#mcq-import-points').value), shuffle: isToggleOn('mcq-import-shuffle'), tag }],
      matching: ['importMatching', { questions: parsedByType.matching, points: parseFloat($('#match-import-points').value), shuffle: isToggleOn('match-import-shuffle'), tag }],
      short:    ['importShort',    { questions: parsedByType.short, points: parseFloat($('#short-import-points').value), similarity: parseInt($('#short-import-similarity').value, 10), tag }],
    };
    const [action, opts] = typeMap[type];

    // Scan for duplicates within this type only
    const typeNameMap = { fib: 'BLANKS', mcq: 'MCQ', matching: 'MATCHING', short: 'SHORT' };
    const scanList = parsedByType[type].map((q, i) => ({ globalIdx: i, type: typeNameMap[type], prompt: q.prompt }));
    const scanResult = await runAction('scanDuplicates', { questions: scanList }, { silent: true });
    const matches = scanResult?.matches || [];

    if (matches.length > 0) {
      showDuplicateReview(matches);
      // Store single-type job for confirm button
      window._pendingSingleTypeJob = { action, opts };
      document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      log(`Found ${matches.length} potential duplicate(s) — review before importing`, 'warn');
    } else {
      log(`Importing ${parsedByType[type].length} ${type.toUpperCase()} question(s)…`);
      opts.resolutions = {};
      opts.globalIdxOffset = 0;
      await runAction(action, opts);
      document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      updateImportUI();
    }
  });
});

// ── Duplicate review confirm button ──────────────────────────────────────────
document.getElementById('btn-review-confirm')?.addEventListener('click', async () => {
  const resolutions = getDuplicateResolutions();
  hideDuplicateReview();
  document.querySelectorAll('.btn').forEach(b => b.disabled = true);
  log('Importing with duplicate resolutions…');

  if (window._pendingSingleTypeJob) {
    // Single-type import with resolutions
    const { action, opts } = window._pendingSingleTypeJob;
    opts.resolutions = resolutions;
    opts.globalIdxOffset = 0;
    await runAction(action, opts);
    window._pendingSingleTypeJob = null;
  } else {
    // Full import with resolutions
    await executeImport(resolutions);
  }

  document.querySelectorAll('.btn').forEach(b => b.disabled = false);
  updateImportUI();
});

// ── Init ─────────────────────────────────────────────────────────────────────
checkContext();
