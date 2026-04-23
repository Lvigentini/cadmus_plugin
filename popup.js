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

// ── Version check ───────────────────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const resp = await fetch(
      'https://api.github.com/repos/Lvigentini/cadmus_plugin/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (!resp.ok) return;
    const release = await resp.json();
    const latest = release.tag_name.replace(/^v/, '');
    const current = chrome.runtime.getManifest().version;
    if (latest !== current && isNewer(latest, current)) {
      document.getElementById('update-text').textContent =
        `v${latest} available (you have v${current})`;
      document.getElementById('update-link').href =
        'https://lvigentini.github.io/cadmus_plugin/';
      document.getElementById('update-banner').style.display = 'flex';
    }
  } catch (_) { /* silent — network errors, rate limits */ }
}

function isNewer(latest, current) {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// ── Find the Cadmus tab (works from both popup and window mode) ─────────────
let cadmusTabId = null;

async function findCadmusTab() {
  // 1. Try the source tab stored by background.js when the icon was clicked
  try {
    const { cadmusSourceTabId } = await chrome.storage.session.get('cadmusSourceTabId');
    if (cadmusSourceTabId) {
      const tab = await chrome.tabs.get(cadmusSourceTabId);
      if (tab?.url && /cadmus\.io/.test(tab.url)) return tab;
    }
  } catch (_) {}

  // 2. Fallback: active tab in current window (works when opened as popup, not window)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url && /cadmus\.io/.test(activeTab.url)) return activeTab;

  // 3. Last resort: any open Cadmus tab
  const tabs = await chrome.tabs.query({ url: 'https://*.cadmus.io/*' });
  return tabs[0] || null;
}

// Base pattern: https://*.cadmus.io/{tenant}/assessment/{assessmentId}/...
const CADMUS_BASE = /^https:\/\/[^/]*cadmus\.io\/([^/]+)\/assessment\/([^/]+)/;

// ── Check context on popup open ──────────────────────────────────────────────
async function checkContext() {
  const tab = await findCadmusTab();
  if (!tab) return setDisconnected('Navigate to a Cadmus assessment page');

  const url = tab.url || '';
  cadmusTabId = tab.id;

  const baseMatch = url.match(CADMUS_BASE);
  if (!baseMatch) return setDisconnected('Navigate to a Cadmus assessment page');

  const tenant = baseMatch[1];
  const path = url.substring(baseMatch[0].length);  // everything after /assessment/{id}

  let context;
  if (/^\/library\b/.test(path)) {
    context = 'library';
  } else if (/^\/class\/marking\b/.test(path)) {
    context = 'marking';
  } else if (/^\/grader\/moderate\b/.test(path)) {
    context = 'moderation';
  } else if (/^\/learning-assurance\b/.test(path)) {
    context = 'learning-assurance';
  } else if (/^\/task\/[^/]+\/edit\b/.test(path)) {
    context = 'assessment';
  } else {
    return setDisconnected('Navigate to a Library, Marking, Assessment Edit, Moderation, or Learning Assurance page');
  }

  setConnected(tenant, baseMatch[2], context);
}

function setConnected(tenant, assessmentId, context) {
  const status = $('#status');
  status.className = 'status status--connected';
  const labels = { library: 'Library', marking: 'Marking', assessment: 'Assessment', moderation: 'Moderation', 'learning-assurance': 'Learning Assurance' };
  $('#status-text').textContent = `Connected — ${labels[context] || context} — ${tenant}`;
  $('#actions').classList.remove('disabled');
  document.body.dataset.tenant = tenant;
  document.body.dataset.assessmentId = assessmentId;
  document.body.dataset.context = context;

  // Show/hide tabs based on context
  const tabVisibility = {
    import: context === 'library',
    edit: context === 'library',
    export: context === 'library' || context === 'assessment',
    delete: context === 'library',
    report: context === 'marking' || context === 'moderation' || context === 'learning-assurance',
    grading: context === 'marking',
  };
  for (const [tab, visible] of Object.entries(tabVisibility)) {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.style.display = visible ? '' : 'none';
  }

  // Hide scope radio buttons on assessment page (always exports all)
  const scopeEl = document.querySelector('.export-scope');
  if (scopeEl) scopeEl.style.display = context === 'assessment' ? 'none' : '';

  // On assessment page: only show exam-ready Word export
  const fmtSelect = $('#export-format');
  if (fmtSelect) {
    for (const opt of fmtSelect.options) {
      opt.hidden = context === 'assessment' && !opt.value.startsWith('docx-exam');
    }
    if (context === 'assessment') fmtSelect.value = 'docx-exam';
  }

  // Activate the first visible tab
  const firstVisible = (context === 'marking' || context === 'moderation' || context === 'learning-assurance') ? 'report' : context === 'assessment' ? 'export' : 'import';
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const activeBtn = document.querySelector(`.tab[data-tab="${firstVisible}"]`);
  const activePanel = document.querySelector(`.tab-panel[data-panel="${firstVisible}"]`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activePanel) activePanel.classList.add('active');
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

    const buildFields = (blanks, distractorPool, qIdx, explicitDistractors) =>
      blanks.map((blank, i) => {
        // First answer is the correct one; extras are discarded (not used as distractors)
        const firstAnswer = blank.answers[0];
        const correctTexts = [firstAnswer.toLowerCase()];
        const correctChoice = { identifier: nanoid(), content: firstAnswer };
        const choices = [correctChoice];
        const correctIds = [correctChoice.identifier];

        const usedTexts = new Set(correctTexts);

        // ── Add distractors ──
        // If explicit distractors provided (from ---DISTRACTORS--- section), use those
        // Otherwise fall back to cross-pollination from other questions
        let distractors = [];

        if (explicitDistractors && explicitDistractors.length > 0) {
          for (const dText of explicitDistractors) {
            const key = dText.toLowerCase();
            if (usedTexts.has(key)) continue;
            usedTexts.add(key);
            distractors.push(dText);
          }
        } else {
          // Cross-pollinate from other questions in the file
          const samePos = (distractorPool[i] || [])
            .filter(d => d.qIdx !== qIdx && !correctTexts.includes(d.text.toLowerCase()));
          const anyPos = Object.values(distractorPool).flat()
            .filter(d => d.qIdx !== qIdx && !correctTexts.includes(d.text.toLowerCase()));

          const pickDistractors = (pool, count) => {
            const picked = [];
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

          distractors = pickDistractors(samePos, 2);
          if (distractors.length < 2) {
            distractors = distractors.concat(pickDistractors(anyPos, 2 - distractors.length));
          }
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
    // Only the first (correct) answer per blank is pooled as a potential distractor
    const distractorPool = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      for (let bi = 0; bi < q.blanks.length; bi++) {
        if (!distractorPool[bi]) distractorPool[bi] = [];
        if (q.blanks[bi].answers.length > 0) {
          distractorPool[bi].push({ text: q.blanks[bi].answers[0], qIdx: qi });
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
      const fields = buildFields(q.blanks, distractorPool, idx, q.explicitDistractors);

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

      // Cadmus matching data model (confirmed from manual question export):
      //   sourceSet = RIGHT side (answers/options), identifiers: right_N
      //   targetSet = LEFT side (prompts/scenarios), identifiers: left_N
      //   correctValues = ["left_1 right_1", "left_2 right_2", ...]
      const sourceSet = q.pairs.map((p, i) => ({
        identifier: `right_${i + 1}`,
        content: p.right,
      }));
      // Append explicit distractors as extra sourceSet entries (no matching target)
      const distractors = q.distractors || [];
      for (let di = 0; di < distractors.length; di++) {
        sourceSet.push({
          identifier: `right_${q.pairs.length + di + 1}`,
          content: distractors[di],
        });
      }
      const targetSet = q.pairs.map((p, i) => ({
        identifier: `left_${i + 1}`,
        content: p.left,
      }));

      // correctValues: "leftId rightId" pairs — only for actual pairs, not distractors
      const correctValues = targetSet.map((t, i) => `${t.identifier} ${sourceSet[i].identifier}`);

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
          // For updates: just replace with correct data model in one step
          // Cadmus model: sourceSet=answers(right_N), targetSet=prompts(left_N)
          const updSourceSet = q.pairs.map((p, pi) => ({
            identifier: `right_${pi + 1}`,
            content: p.right,
          }));
          // Append explicit distractors as extra sourceSet entries
          const updDistractors = q.distractors || [];
          for (let di = 0; di < updDistractors.length; di++) {
            updSourceSet.push({
              identifier: `right_${q.pairs.length + di + 1}`,
              content: updDistractors[di],
            });
          }
          const updTargetSet = q.pairs.map((p, pi) => ({
            identifier: `left_${pi + 1}`,
            content: p.left,
          }));
          const updCorrectValues = updTargetSet.map((t, pi) => `${t.identifier} ${updSourceSet[pi].identifier}`);

          const fd = await gql(FETCH_Q, { questionId: existing.id }, hdrs);
          if (fd.errors) { logs.push({ msg: `Matching Q${idx + 1} fetch failed`, cls: 'err' }); failed++; continue; }
          const eq = fd.data.question;

          const updFields = [{
            identifier: eq.body?.fields?.[0]?.identifier || '1',
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
            logs.push({ msg: `Matching Q${idx + 1} updated — ${eq.shortPrompt?.substring(0, 40)} (${q.pairs.length} pairs)`, cls: 'ok' });
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

  // --- Fix Matching Questions — rebuild with correct Cadmus data model ---
  // Cadmus model: sourceSet = answers (right_N), targetSet = prompts (left_N)
  // correctValues = ["left_1 right_1", "left_2 right_2", ...]
  async function fixMatchingQuestions(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };

    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };

    let rows;
    const selected = table.getSelectedRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    if (selected.length > 0) {
      rows = selected;
    } else {
      rows = table.getRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    }
    if (!rows.length) return { error: 'No matching questions found in the library' };

    const logs = [];
    let fixed = 0, skipped = 0, failed = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const qId = rows[ri].original.id;
      const label = rows[ri].original.shortPrompt?.substring(0, 50) || qId;

      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed: ${label}`, cls: 'err' }); failed++; continue; }

      const q = fd.data.question;
      const field = q.body?.fields?.[0];
      const inter = field?.interaction;
      if (!inter?.sourceSet || !inter?.targetSet) {
        logs.push({ msg: `${label} — no match interaction, skipped`, cls: 'warn' }); skipped++; continue;
      }

      const oldSources = inter.sourceSet;
      const oldTargets = inter.targetSet;
      const cv = field.response?.correctValues || [];

      // Check if already using correct model (sourceSet has right_* IDs)
      const alreadyCorrect = oldSources.length > 0
        && oldSources[0].identifier.startsWith('right_')
        && oldTargets[0].identifier.startsWith('left_')
        && cv.length > 0
        && cv[0].startsWith('left_');

      // Detect mismatch: more prompts (targets/left) than answers (sources/right)
      // In correct model: targetSet = prompts, sourceSet = answers
      // In broken model: sourceSet = prompts, targetSet = answers
      const prompts = alreadyCorrect ? oldTargets.length : oldSources.length;
      const answers = alreadyCorrect ? oldSources.length : oldTargets.length;
      if (prompts > answers) {
        logs.push({ msg: `⚠ ${label} — ${prompts} prompts but only ${answers} answers — needs manual fix  [ID: ${qId}]`, cls: 'err' });
        failed++;
        continue;
      }

      if (alreadyCorrect) {
        logs.push({ msg: `${label} — already correct model, skipped`, cls: 'ok' });
        skipped++;
        continue;
      }

      // Detect the broken structure:
      // Old import put: sourceSet = prompts (left), targetSet = answers (right)
      // We need to rebuild with: sourceSet = answers (right_N), targetSet = prompts (left_N)
      // The number of actual pairs = oldSources.length (prompts)
      // Extra items in oldTargets beyond that count are distractors
      const pairCount = oldSources.length;
      logs.push({ msg: `${label}: ${pairCount} pairs, ${oldTargets.length} old targets (${oldTargets.length - pairCount} extra)`, cls: 'warn' });

      // Rebuild: prompts are in oldSources, answers are in first N of oldTargets
      const newSourceSet = [];  // answers → right_N
      const newTargetSet = [];  // prompts → left_N
      for (let i = 0; i < pairCount; i++) {
        newTargetSet.push({ identifier: `left_${i + 1}`, content: oldSources[i].content });
        newSourceSet.push({ identifier: `right_${i + 1}`, content: oldTargets[i]?.content || '' });
      }
      const newCv = newTargetSet.map((t, i) => `${t.identifier} ${newSourceSet[i].identifier}`);

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
              correctValues: newCv,
              correctRanges: [], correctAreas: [], caseSensitive: field.response.caseSensitive, errorMargin: null, baseType: null,
            },
            matchInteraction: {
              sourceSet: newSourceSet.map(s => ({ identifier: s.identifier, content: s.content })),
              targetSet: newTargetSet.map(t => ({ identifier: t.identifier, content: t.content })),
            },
          }],
        },
      };

      const res = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (res.errors) {
        logs.push({ msg: `  → FAILED: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        logs.push({ msg: `  → fixed: ${pairCount} pairs, ${newCv.length} correctValues, ${oldTargets.length - pairCount} distractors removed`, cls: 'ok' });
        fixed++;
      }
    }

    if (fixed > 0) await refreshLibrary();
    logs.push({ msg: `Fix complete: ${fixed} fixed, ${skipped} skipped, ${failed} failed`, cls: fixed > 0 ? 'ok' : 'err' });
    return { success: failed === 0, processed: fixed, skipped, logs };
  }

  // --- Fix Fill-in-Blank Questions — reduce to one correct answer per blank ---
  async function fixFIBQuestions(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };

    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };

    let rows;
    const selected = table.getSelectedRowModel().rows.filter(r => r.original.questionType === 'BLANKS');
    if (selected.length > 0) {
      rows = selected;
    } else {
      rows = table.getRowModel().rows.filter(r => r.original.questionType === 'BLANKS');
    }
    if (!rows.length) return { error: 'No fill-in-blank questions found in the library' };

    const logs = [];
    let fixed = 0, skipped = 0, failed = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const qId = rows[ri].original.id;
      const label = rows[ri].original.shortPrompt?.substring(0, 50) || qId;

      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed: ${label}`, cls: 'err' }); failed++; continue; }

      const q = fd.data.question;
      const fields = q.body?.fields || [];
      if (!fields.length) { logs.push({ msg: `${label} — no fields, skipped`, cls: 'warn' }); skipped++; continue; }

      // Check if any blank has more than 1 correct answer
      let needsFix = false;
      for (const f of fields) {
        if ((f.response?.correctValues || []).length > 1) { needsFix = true; break; }
      }
      if (!needsFix) {
        logs.push({ msg: `${label} — already 1 correct per blank, skipped`, cls: 'ok' });
        skipped++;
        continue;
      }

      // Rebuild fields: keep first correctValue, delete extra correct choices, retain distractors
      const newFields = fields.map(f => {
        const cv = f.response?.correctValues || [];
        const choices = f.interaction?.choices || [];
        const keepId = cv[0];  // first correct identifier
        const extraCorrectIds = new Set(cv.slice(1));  // IDs to remove from choices
        const newChoices = choices.filter(c => !extraCorrectIds.has(c.identifier));
        return {
          identifier: f.identifier,
          response: {
            partialScoring: f.response.partialScoring,
            matchSimilarity: null,
            correctValues: keepId ? [keepId] : [],
            correctRanges: [],
            correctAreas: [],
            caseSensitive: f.response.caseSensitive,
            errorMargin: null,
            baseType: null,
          },
          choiceInteraction: {
            choices: newChoices.map(c => ({ identifier: c.identifier, content: c.content })),
          },
        };
      });

      const blanksFixed = fields.filter(f => (f.response?.correctValues || []).length > 1).length;

      const input = {
        id: q.id,
        attributes: {
          promptDoc: q.body.promptDoc, questionType: q.questionType, shortPrompt: q.shortPrompt,
          feedback: q.body.feedback, promptImage: null, parentQuestionId: q.parentQuestionId,
          points: q.points, shuffle: q.shuffle,
          fields: newFields,
        },
      };

      const res = await gql(UPDATE_Q, { input, childrenQuestions: [] }, hdrs);
      if (res.errors) {
        logs.push({ msg: `  → FAILED: ${res.errors[0].message}`, cls: 'err' });
        failed++;
      } else {
        logs.push({ msg: `${label} — fixed ${blanksFixed} blank(s) (reduced to 1 correct each)`, cls: 'ok' });
        fixed++;
      }
    }

    if (fixed > 0) await refreshLibrary();
    logs.push({ msg: `Fix complete: ${fixed} fixed, ${skipped} already correct, ${failed} failed`, cls: fixed > 0 ? 'ok' : 'err' });
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
        // Build pairs from correctValues — format is "leftId rightId"
        // sourceSet = right side (answers), targetSet = left side (prompts)
        qObj.pairs = [];
        for (const cv of (field.response?.correctValues || [])) {
          const parts = cv.split(' ');
          if (parts.length === 2) {
            const leftItem = qObj.targetSet.find(t => t.identifier === parts[0]);
            const rightItem = qObj.sourceSet.find(s => s.identifier === parts[1]);
            if (leftItem && rightItem) qObj.pairs.push({ left: leftItem.content, right: rightItem.content });
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
  // --- Check Matching Balance — report prompts vs answers for each question ---
  async function checkMatchingBalance(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'AUTHOR', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };

    const table = findTanStackTable();
    if (!table) return { error: 'Could not find table instance. Is the library loaded?' };

    let rows;
    const selected = table.getSelectedRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    if (selected.length > 0) {
      rows = selected;
    } else {
      rows = table.getRowModel().rows.filter(r => r.original.questionType === 'MATCHING');
    }
    if (!rows.length) return { error: 'No matching questions found in the library' };

    const logs = [];
    let ok = 0, issues = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const qId = rows[ri].original.id;
      const libId = rows[ri].original.libraryId || '';
      const label = rows[ri].original.shortPrompt?.substring(0, 60) || qId;

      const fd = await gql(FETCH_Q, { questionId: qId }, hdrs);
      if (fd.errors) { logs.push({ msg: `Fetch failed: ${label}`, cls: 'err' }); issues++; continue; }

      const q = fd.data.question;
      const field = q.body?.fields?.[0];
      const inter = field?.interaction;
      if (!inter?.sourceSet || !inter?.targetSet) {
        logs.push({ msg: `#${libId} ${label} — no match data`, cls: 'warn' }); issues++; continue;
      }

      const fields = q.body?.fields || [];
      let qIssues = [];

      for (let fi = 0; fi < fields.length; fi++) {
        const f = fields[fi];
        const fInter = f.interaction;
        if (!fInter?.sourceSet && !fInter?.targetSet) continue;

        const sources = fInter.sourceSet || [];
        const targets = fInter.targetSet || [];
        const cv = f.response?.correctValues || [];

        // Dump every entry for diagnosis
        logs.push({ msg: `#${libId} field[${fi}] — ${sources.length} sourceSet, ${targets.length} targetSet, ${cv.length} correctValues  [${label}]`, cls: 'warn' });
        for (let si = 0; si < sources.length; si++) {
          const s = sources[si];
          const txt = (s.content || '').substring(0, 50) || '(empty)';
          const paired = cv.some(c => c.includes(s.identifier));
          logs.push({ msg: `  src[${si}] ${s.identifier}: "${txt}" ${paired ? '✓ paired' : '✗ NOT paired'}`, cls: paired ? 'ok' : 'err' });
        }
        for (let ti = 0; ti < targets.length; ti++) {
          const t = targets[ti];
          const txt = (t.content || '').substring(0, 50) || '(empty)';
          const paired = cv.some(c => c.includes(t.identifier));
          logs.push({ msg: `  tgt[${ti}] ${t.identifier}: "${txt}" ${paired ? '✓ paired' : '✗ NOT paired'}`, cls: paired ? 'ok' : 'err' });
        }

        // Check for problems
        const srcBlank = sources.filter(s => !s.content || !s.content.trim()).length;
        const tgtBlank = targets.filter(t => !t.content || !t.content.trim()).length;
        const unpairedSrc = sources.filter(s => !cv.some(c => c.includes(s.identifier))).length;
        const unpairedTgt = targets.filter(t => !cv.some(c => c.includes(t.identifier))).length;

        if (srcBlank > 0) qIssues.push(`${srcBlank} blank source(s)`);
        if (tgtBlank > 0) qIssues.push(`${tgtBlank} blank target(s)`);
        if (unpairedSrc > 0 && unpairedSrc !== (sources.length - targets.length)) qIssues.push(`${unpairedSrc} unpaired source(s)`);
        if (unpairedTgt > 0) qIssues.push(`${unpairedTgt} unpaired target(s)`);
        if (sources.length < targets.length) qIssues.push(`fewer sources (${sources.length}) than targets (${targets.length})`);
      }

      if (qIssues.length > 0) {
        logs.push({ msg: `#${libId} — NEEDS FIX: ${qIssues.join('; ')}`, cls: 'err' });
        issues++;
      } else {
        logs.push({ msg: `#${libId} — OK`, cls: 'ok' });
        ok++;
      }
    }

    logs.push({ msg: `Check complete: ${ok} OK, ${issues} issue(s) out of ${rows.length} question(s)`, cls: issues > 0 ? 'err' : 'ok' });
    return { success: issues === 0, logs };
  }

  // --- Grading: shared state and helpers ---
  if (!window.__gradingState) window.__gradingState = {};

  const WORK_OUTCOME_Q = `query WorkOutcome($workId: ID!) {
    workOutcome(workId: $workId) {
      id workId studentId maxScore
      scoreBreakdown { score automark marker markerModifier moderatorModifier }
      questionOutcomes {
        id questionId
        scoreBreakdown { score automark marker markerModifier moderatorModifier }
        fieldOutcomes { id identifier score automarkScore automarkStatus answer answers answerSimilarity }
      }
    }
  }`;

  const QUESTION_BODY_Q = `query QuestionContent($questionId: ID!) {
    question(questionId: $questionId) {
      id body {
        promptDoc
        fields {
          identifier
          response { correctValues }
          interaction {
            ... on ChoiceInteraction { choices { identifier content } maxChoices }
            ... on TextEntryInteraction { expectedLength }
          }
        }
      }
    }
  }`;

  const MARK_FIELD_M = `mutation MarkFieldOutcome($assessmentId: ID!, $input: MarkFieldOutcomeInput!) {
    markFieldOutcome(assessmentId: $assessmentId, input: $input) {
      fieldOutcome { id score markerScore automarkScore }
      questionOutcome { id scoreBreakdown { score automark marker markerModifier } }
      workOutcome { id scoreBreakdown { score automark marker markerModifier } }
    }
  }`;

  function extractText(doc) {
    if (!doc) return '';
    try {
      const d = typeof doc === 'string' ? JSON.parse(doc) : doc;
      const t = [];
      const w = (n) => { if (n.type === 'text') t.push(n.text || ''); if (n.content) n.content.forEach(w); };
      w(d); return t.join('').trim();
    } catch (_) { return String(doc); }
  }

  // --- Grading: Load Data ---
  async function gradingLoadData(opts) {
    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'lecturer', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const cache = window.__APOLLO_CLIENT__?.cache?.extract();
    if (!cache) return { error: 'Apollo Client not found — is the marking page fully loaded?' };

    const logs = [];

    // 1. Extract Enrollments + Users from cache
    const users = {};
    Object.values(cache).forEach(v => { if (v?.__typename === 'User' && v.id) users[v.id] = v; });

    const students = [];
    Object.values(cache).forEach(v => {
      if (v?.__typename !== 'Enrollment' || v.deleted) return;
      const userId = v.user?.__ref?.replace('User:', '') || v.userId;
      const workId = v.work?.__ref?.replace('Work:', '') || v.workId;
      if (!workId) return;
      const u = users[userId] || {};
      students.push({
        userId, workId,
        name: u.name || u.givenName || '',
        email: u.email || '',
        sisId: v.sisUserId || '',
      });
    });
    logs.push({ msg: `Found ${students.length} enrolled students`, cls: 'ok' });

    // 2. Extract questions from cache
    const questionMap = {};
    Object.values(cache).forEach(v => {
      if (v?.__typename === 'Question' && v.id && v.questionType) questionMap[v.id] = v;
    });
    const blanksQs = Object.values(questionMap).filter(q => q.questionType === 'BLANKS');
    const shortQs = Object.values(questionMap).filter(q => q.questionType === 'SHORT');
    logs.push({ msg: `Questions in cache: ${blanksQs.length} BLANKS, ${shortQs.length} SHORT`, cls: 'ok' });

    // 3. Batch-fetch BLANKS question bodies (need correctValues + choiceMap)
    const questionBodies = {};
    const BATCH = 5, DELAY = 300;

    for (let i = 0; i < blanksQs.length; i += BATCH) {
      await Promise.all(blanksQs.slice(i, i + BATCH).map(async q => {
        const res = await gql(QUESTION_BODY_Q, { questionId: q.id }, hdrs);
        const body = res?.data?.question?.body;
        if (body) {
          questionBodies[q.id] = {
            promptText: extractText(body.promptDoc),
            questionType: 'BLANKS',
            points: q.points ?? 1,
            fields: (body.fields || []).map(f => {
              const choiceMap = {};
              (f.interaction?.choices || []).forEach(c => { choiceMap[c.identifier] = c.content; });
              return { identifier: f.identifier, correctValues: f.response?.correctValues || [], choiceMap };
            }),
          };
        }
      }));
      logs.push({ msg: `Question bodies: ${Math.min(i + BATCH, blanksQs.length)}/${blanksQs.length}`, cls: 'ok' });
      if (i + BATCH < blanksQs.length) await new Promise(r => setTimeout(r, DELAY));
    }

    // 4. SHORT question bodies — extract from cache (already hydrated)
    for (const q of shortQs) {
      const body = q.body;
      if (body) {
        questionBodies[q.id] = {
          promptText: extractText(body.promptDoc || body.prompt || ''),
          questionType: 'SHORT',
          points: q.points ?? 1,
          fields: (body.fields || []).map(f => ({
            identifier: f.identifier,
            correctValues: f.response?.correctValues || [],
            choiceMap: {},
          })),
        };
      }
    }

    // 5. Batch-fetch WorkOutcomes
    const workOutcomes = {};
    for (let i = 0; i < students.length; i += BATCH) {
      await Promise.all(students.slice(i, i + BATCH).map(async s => {
        const res = await gql(WORK_OUTCOME_Q, { workId: s.workId }, hdrs);
        const wo = res?.data?.workOutcome;
        if (wo) workOutcomes[s.workId] = { student: s, outcome: wo };
      }));
      if ((i % 20) < BATCH) logs.push({ msg: `Work outcomes: ${Math.min(i + BATCH, students.length)}/${students.length}`, cls: 'ok' });
      if (i + BATCH < students.length) await new Promise(r => setTimeout(r, DELAY));
    }
    logs.push({ msg: `Loaded ${Object.keys(workOutcomes).length} work outcomes`, cls: 'ok' });

    // 6. Build BLANKS audit rows
    const blanksAuditRows = [];
    const qIds = Object.keys(questionBodies).filter(id => questionBodies[id].questionType === 'BLANKS');
    const qNum = {}; qIds.forEach((id, i) => { qNum[id] = i + 1; });

    Object.values(workOutcomes).forEach(({ student, outcome }) => {
      (outcome.questionOutcomes || []).forEach(qo => {
        if (!questionBodies[qo.questionId] || questionBodies[qo.questionId].questionType !== 'BLANKS') return;
        const qBody = questionBodies[qo.questionId];
        const qScore = qo.scoreBreakdown?.score ?? '';

        (qo.fieldOutcomes || []).forEach(fo => {
          const fieldDef = qBody.fields.find(f => f.identifier === fo.identifier) || qBody.fields[0] || {};
          const choiceMap = fieldDef.choiceMap || {};
          const correctVals = fieldDef.correctValues || [];
          const studentAnss = fo.answers?.length ? fo.answers : (fo.answer ? [fo.answer] : []);
          const studentTxts = studentAnss.map(a => choiceMap[a] || a);
          const correctTxts = correctVals.map(cv => choiceMap[cv] || cv);
          const hasCorrect = studentAnss.some(a => correctVals.includes(a));
          const foScore = fo.score ?? 0;

          blanksAuditRows.push({
            StudentName: student.name,
            StudentID: student.sisId,
            StudentEmail: student.email,
            QuestionNo: qNum[qo.questionId] || '',
            QuestionID: qo.questionId,
            QuestionPrompt: (qBody.promptText || '').substring(0, 200),
            FieldIdentifier: fo.identifier,
            FieldOutcomeId: fo.id,
            StudentAnswer: studentTxts.length ? studentTxts.join('; ') : '(no answer)',
            CorrectAnswers: correctTxts.join(' | '),
            IsCorrect: hasCorrect ? 'YES' : 'NO',
            FieldAutomark: fo.automarkScore ?? '',
            FieldScore: foScore,
            QuestionScore: qScore,
            QuestionMaxScore: qBody.points ?? 1,
            WouldBumpToOne: (hasCorrect && foScore !== '' && foScore < 1) ? 'YES' : 'NO',
          });
        });
      });
    });

    blanksAuditRows.sort((a, b) => {
      const n = String(a.StudentName).localeCompare(String(b.StudentName));
      return n !== 0 ? n : (a.QuestionNo - b.QuestionNo);
    });

    // 7. Build SHORT rows
    const shortRows = [];
    const shortIds = Object.keys(questionBodies).filter(id => questionBodies[id].questionType === 'SHORT');
    const shortNum = {}; shortIds.forEach((id, i) => { shortNum[id] = i + 1; });

    Object.values(workOutcomes).forEach(({ student, outcome }) => {
      (outcome.questionOutcomes || []).forEach(qo => {
        if (!questionBodies[qo.questionId] || questionBodies[qo.questionId].questionType !== 'SHORT') return;
        const qBody = questionBodies[qo.questionId];
        const correctVals = qBody.fields[0]?.correctValues || [];

        (qo.fieldOutcomes || []).forEach(fo => {
          shortRows.push({
            StudentName: student.name,
            StudentID: student.sisId,
            StudentEmail: student.email,
            QuestionNo: shortNum[qo.questionId] || '',
            QuestionID: qo.questionId,
            QuestionPrompt: (qBody.promptText || '').substring(0, 300),
            ExpectedAnswer: (correctVals[0] || '').substring(0, 500),
            StudentAnswer: fo.answer || '',
            AnswerSimilarity: fo.answerSimilarity ?? '',
            AutomarkScore: fo.automarkScore ?? 0,
            FieldScore: fo.score ?? 0,
            FieldOutcomeId: fo.id,
          });
        });
      });
    });

    shortRows.sort((a, b) => {
      const n = String(a.StudentName).localeCompare(String(b.StudentName));
      return n !== 0 ? n : (a.QuestionNo - b.QuestionNo);
    });

    // Store state
    const fixCandidates = blanksAuditRows.filter(r => r.WouldBumpToOne === 'YES');
    window.__gradingState = {
      questionBodies, workOutcomes,
      blanksAuditRows, shortRows, fixCandidates,
      dataLoaded: true, blanksFixApplied: false,
    };

    logs.push({ msg: `BLANKS audit: ${blanksAuditRows.length} field rows, ${fixCandidates.length} penalised (would bump to 1)`, cls: fixCandidates.length > 0 ? 'warn' : 'ok' });
    logs.push({ msg: `SHORT answers: ${shortRows.length} rows across ${shortIds.length} questions`, cls: 'ok' });

    return {
      success: true,
      students: students.length,
      blanksQuestions: blanksQs.length,
      shortQuestions: shortQs.length,
      blanksFields: blanksAuditRows.length,
      fixCandidates: fixCandidates.length,
      shortFields: shortRows.length,
      shortModelAnswers: shortIds.map((id, i) => {
        const qBody = questionBodies[id];
        const answer = qBody.fields[0]?.correctValues?.[0] || '';
        return {
          questionNo: i + 1,
          questionId: id,
          prompt: (qBody.promptText || '').substring(0, 120),
          modelAnswer: answer.substring(0, 150),
          hasAnswer: !!answer,
        };
      }),
      logs,
    };
  }

  // --- Grading: Export BLANKS Audit CSV ---
  async function gradingExportBlanksCsv(opts) {
    const rows = window.__gradingState?.blanksAuditRows;
    if (!rows?.length) return { error: 'No BLANKS audit data — run Load Data first' };

    const cols = ['StudentName', 'StudentID', 'StudentEmail', 'QuestionNo', 'QuestionID', 'QuestionPrompt',
      'FieldIdentifier', 'StudentAnswer', 'CorrectAnswers', 'IsCorrect', 'FieldAutomark', 'FieldScore',
      'QuestionScore', 'QuestionMaxScore', 'WouldBumpToOne'];
    const esc = v => { const s = String(v ?? '').replace(/"/g, '""'); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s; };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    return { csv, rows: rows.length };
  }

  // --- Grading: Fix BLANKS Partial Scoring ---
  async function gradingFixBlanks(opts) {
    const state = window.__gradingState;
    if (!state?.dataLoaded) return { error: 'No data loaded — run Load Data first' };

    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'lecturer', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const toFix = state.fixCandidates || [];
    const logs = [];

    if (!toFix.length) {
      logs.push({ msg: 'No fields to fix — all correct answers already at full score', cls: 'ok' });
      return { success: true, fixed: 0, errors: 0, logs };
    }

    if (opts.dryRun) {
      logs.push({ msg: `DRY RUN: ${toFix.length} field(s) would be bumped to score = 1`, cls: 'warn' });
      for (const row of toFix.slice(0, 10)) {
        logs.push({ msg: `  ${row.StudentName} | Q${row.QuestionNo} | "${row.StudentAnswer}" | ${row.FieldScore} → 1`, cls: 'warn' });
      }
      if (toFix.length > 10) logs.push({ msg: `  ... and ${toFix.length - 10} more`, cls: 'warn' });
      return { success: true, fixed: 0, errors: 0, dryRun: true, total: toFix.length, logs };
    }

    // Live fix
    const BATCH = 3, DELAY = 400;
    let fixed = 0, errors = 0;
    for (let i = 0; i < toFix.length; i += BATCH) {
      await Promise.all(toFix.slice(i, i + BATCH).map(async row => {
        const res = await gql(MARK_FIELD_M, {
          assessmentId,
          input: { fieldOutcomeId: row.FieldOutcomeId, score: 1 },
        }, hdrs);
        if (res.errors) {
          errors++;
          logs.push({ msg: `Fix failed: ${row.StudentName} Q${row.QuestionNo} — ${res.errors[0].message}`, cls: 'err' });
        } else {
          fixed++;
        }
      }));
      if ((i % 15) < BATCH) logs.push({ msg: `Progress: ${Math.min(i + BATCH, toFix.length)}/${toFix.length} | fixed: ${fixed} | errors: ${errors}`, cls: 'ok' });
      if (i + BATCH < toFix.length) await new Promise(r => setTimeout(r, DELAY));
    }

    state.blanksFixApplied = true;
    logs.push({ msg: `Fix complete: ${fixed} updated, ${errors} errors`, cls: errors > 0 ? 'err' : 'ok' });
    return { success: errors === 0, fixed, errors, logs };
  }

  // --- Grading: Export Updated CSV (re-fetches WorkOutcomes) ---
  async function gradingExportUpdatedCsv(opts) {
    const state = window.__gradingState;
    if (!state?.dataLoaded) return { error: 'No data loaded — run Load Data first' };

    const { tenant, assessmentId } = parseCadmusUrl();
    const hdrs = { 'x-cadmus-role': 'lecturer', 'x-cadmus-tenant': tenant, 'x-cadmus-assessment': assessmentId };
    const logs = [];

    // Re-fetch all WorkOutcomes
    const students = Object.values(state.workOutcomes).map(wo => wo.student);
    const BATCH = 5, DELAY = 300;
    const freshOutcomes = {};

    for (let i = 0; i < students.length; i += BATCH) {
      await Promise.all(students.slice(i, i + BATCH).map(async s => {
        const res = await gql(WORK_OUTCOME_Q, { workId: s.workId }, hdrs);
        const wo = res?.data?.workOutcome;
        if (wo) freshOutcomes[s.workId] = { student: s, outcome: wo };
      }));
      if (i + BATCH < students.length) await new Promise(r => setTimeout(r, DELAY));
    }
    logs.push({ msg: `Re-fetched ${Object.keys(freshOutcomes).length} work outcomes`, cls: 'ok' });

    // Rebuild BLANKS audit rows with fresh scores
    const qBodies = state.questionBodies;
    const rows = [];
    const qIds = Object.keys(qBodies).filter(id => qBodies[id].questionType === 'BLANKS');
    const qNum = {}; qIds.forEach((id, i) => { qNum[id] = i + 1; });

    Object.values(freshOutcomes).forEach(({ student, outcome }) => {
      (outcome.questionOutcomes || []).forEach(qo => {
        if (!qBodies[qo.questionId] || qBodies[qo.questionId].questionType !== 'BLANKS') return;
        const qBody = qBodies[qo.questionId];
        (qo.fieldOutcomes || []).forEach(fo => {
          const fieldDef = qBody.fields.find(f => f.identifier === fo.identifier) || qBody.fields[0] || {};
          const choiceMap = fieldDef.choiceMap || {};
          const correctVals = fieldDef.correctValues || [];
          const studentAnss = fo.answers?.length ? fo.answers : (fo.answer ? [fo.answer] : []);
          const studentTxts = studentAnss.map(a => choiceMap[a] || a);
          const correctTxts = correctVals.map(cv => choiceMap[cv] || cv);
          const hasCorrect = studentAnss.some(a => correctVals.includes(a));
          rows.push({
            StudentName: student.name, StudentID: student.sisId, StudentEmail: student.email,
            QuestionNo: qNum[qo.questionId] || '', QuestionID: qo.questionId,
            QuestionPrompt: (qBody.promptText || '').substring(0, 200),
            FieldIdentifier: fo.identifier, StudentAnswer: studentTxts.length ? studentTxts.join('; ') : '(no answer)',
            CorrectAnswers: correctTxts.join(' | '), IsCorrect: hasCorrect ? 'YES' : 'NO',
            FieldAutomark: fo.automarkScore ?? '', FieldScore: fo.score ?? 0,
            QuestionScore: qo.scoreBreakdown?.score ?? '', QuestionMaxScore: qBody.points ?? 1,
            WouldBumpToOne: (hasCorrect && (fo.score ?? 0) < 1) ? 'YES' : 'NO',
          });
        });
      });
    });

    rows.sort((a, b) => { const n = String(a.StudentName).localeCompare(String(b.StudentName)); return n !== 0 ? n : (a.QuestionNo - b.QuestionNo); });

    const cols = ['StudentName', 'StudentID', 'StudentEmail', 'QuestionNo', 'QuestionID', 'QuestionPrompt',
      'FieldIdentifier', 'StudentAnswer', 'CorrectAnswers', 'IsCorrect', 'FieldAutomark', 'FieldScore',
      'QuestionScore', 'QuestionMaxScore', 'WouldBumpToOne'];
    const esc = v => { const s = String(v ?? '').replace(/"/g, '""'); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s; };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');

    const stillPenalised = rows.filter(r => r.WouldBumpToOne === 'YES').length;
    logs.push({ msg: `Updated CSV: ${rows.length} rows, ${stillPenalised} still penalised`, cls: stillPenalised > 0 ? 'warn' : 'ok' });
    return { csv, rows: rows.length, logs };
  }

  // --- Grading: Export SHORT Answers CSV ---
  async function gradingExportShortCsv(opts) {
    const rows = window.__gradingState?.shortRows;
    if (!rows?.length) return { error: 'No SHORT answer data — run Load Data first' };

    // Merge any uploaded model answers (passed from popup context)
    const uploaded = opts.uploadedAnswers || {};

    const cols = ['StudentName', 'StudentID', 'StudentEmail', 'QuestionNo', 'QuestionID',
      'QuestionPrompt', 'ExpectedAnswer', 'StudentAnswer', 'AnswerSimilarity',
      'AutomarkScore', 'FieldScore', 'FieldOutcomeId'];
    const esc = v => { const s = String(v ?? '').replace(/"/g, '""'); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s; };

    const enriched = rows.map(r => {
      const override = uploaded[r.QuestionNo] || uploaded[r.QuestionID];
      return {
        ...r,
        ExpectedAnswer: override || r.ExpectedAnswer || '',
      };
    });

    const csv = [cols.join(','), ...enriched.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    return { csv, rows: enriched.length };
  }

  const actions = { editMCQ, editMatching, editShort, deleteSelected, importFIB, importMCQ, importMatching, importShort, exportQuestions, fixMatchingQuestions, fixFIBQuestions, checkMatchingBalance, scanDuplicates, gradingLoadData, gradingExportBlanksCsv, gradingFixBlanks, gradingExportUpdatedCsv, gradingExportShortCsv };
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
    const answersRawFull = get('answers');
    const explanation = get('explanation');

    // Split at ---DISTRACTORS--- separator if present
    const distSep = '---DISTRACTORS---';
    const distIdx = answersRawFull.indexOf(distSep);
    const answersRaw = distIdx === -1 ? answersRawFull : answersRawFull.substring(0, distIdx).trim();
    const distractorsRaw = distIdx === -1 ? '' : answersRawFull.substring(distIdx + distSep.length).trim();

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

      // Explicit distractors from ---DISTRACTORS--- section
      const explicitDistractors = distractorsRaw
        ? distractorsRaw.split(/[;\n]/).map(d => d.trim()).filter(Boolean)
        : [];

      result.fib.push({
        ident: `XLSX_Q${num}`,
        prompt,
        blanks: groups.map(g => ({ answers: g })),
        explicitDistractors,
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

      // Append explicit distractors as additional wrong choices
      if (distractorsRaw) {
        const extraWrong = distractorsRaw.split(/[;\n]/).map(d => d.trim()).filter(Boolean);
        for (const dText of extraWrong) {
          choices.push({ text: dText.replace(/^[A-Za-z][.)]\s*/, ''), correct: false });
        }
      }

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

      // Explicit distractors = extra right-side options with no correct pairing
      const matchDistractors = distractorsRaw
        ? distractorsRaw.split(/\n|\r\n?/).map(d => d.trim()).filter(Boolean)
        : [];

      if (pairs.length > 0) {
        result.matching.push({
          prompt: questionText,
          pairs,
          distractors: matchDistractors,
          feedback: explanation || '',
          tags,
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

async function exportToDocx(data, { randomise = false, examReady = false, showAnswerKey = false } = {}) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, BorderStyle, AlignmentType } = docx;

  const allQuestions = [...data.questions];

  // Group by section (sectionIndex 0 = no sections defined → treat as single group)
  const hasSections = allQuestions.some(q => q.sectionIndex > 0);
  const sectionMap = new Map();
  for (const q of allQuestions) {
    const key = hasSections ? q.sectionIndex : 0;
    if (!sectionMap.has(key)) sectionMap.set(key, { title: q.sectionTitle || '', questions: [] });
    sectionMap.get(key).questions.push(q);
  }

  // Sort sections by their index key
  const sections = [...sectionMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  // Within each section: shuffle or sort by type
  const typeOrder = { MCQ: 0, MATCHING: 1, BLANKS: 2, SHORT: 3 };
  for (const sec of sections) {
    if (randomise) {
      for (let i = sec.questions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sec.questions[i], sec.questions[j]] = [sec.questions[j], sec.questions[i]];
      }
    } else {
      sec.questions.sort((a, b) => (typeOrder[a.questionType] ?? 9) - (typeOrder[b.questionType] ?? 9));
    }
  }

  const typeLabels = { MCQ: 'Multiple Choice', MATCHING: 'Matching', BLANKS: 'Fill-in-the-Blank', SHORT: 'Short Answer' };
  const children = [];

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];

    // Section / part heading
    if (hasSections && sec.title) {
      if (si > 0) children.push(new Paragraph({ pageBreakBefore: true }));
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: sec.title, bold: true, size: 32 })],
        spacing: { after: 200 },
      }));
    }

    let currentType = null;
    let qNum = 0;

  for (let qi = 0; qi < sec.questions.length; qi++) {
    const q = sec.questions[qi];
    qNum++;

    // Sub-heading when type changes (sorted/non-randomised mode, and either no sections or within a section)
    if (!randomise && q.questionType !== currentType) {
      currentType = q.questionType;
      if (!hasSections && qi > 0) {
        children.push(new Paragraph({ pageBreakBefore: true }));
      }
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: typeLabels[q.questionType] || q.questionType, bold: true, size: 26 })],
        spacing: { after: 160 },
      }));
      qNum = 1;  // restart numbering per type group
    }

    const qChildren = [];

    if (examReady) {
      // Exam mode: just question number and prompt
      qChildren.push(new Paragraph({
        keepNext: true,
        children: [new TextRun({ text: `${qNum}.  `, bold: true, size: 22 }), new TextRun({ text: q.prompt || '', size: 22 })],
        spacing: { before: 300, after: 120 },
      }));
    } else {
      // Full mode: metadata line + prompt
      const metaParts = [`Q${qi + 1}`];
      if (randomise) metaParts.push(typeLabels[q.questionType] || q.questionType);
      if (q.difficulty) metaParts.push(q.difficulty);
      if (q.points) metaParts.push(`${q.points} pt${q.points !== 1 ? 's' : ''}`);
      if (q.tags?.length) metaParts.push(q.tags.join(', '));

      qChildren.push(new Paragraph({
        keepNext: true,
        children: [new TextRun({ text: metaParts.join('  |  '), bold: true, size: 20, color: '666666' })],
        spacing: { before: 300 },
      }));

      qChildren.push(new Paragraph({
        keepNext: true,
        children: [new TextRun({ text: q.prompt || '', size: 22 })],
        spacing: { after: 120 },
      }));
    }

    // MCQ choices
    if (q.questionType === 'MCQ' && q.choices?.length) {
      for (const c of q.choices) {
        const label = String.fromCharCode(65 + q.choices.indexOf(c));
        const runs = [
          new TextRun({ text: `${label}. `, bold: true, size: 20 }),
          new TextRun({ text: c.text, size: 20 }),
        ];
        // Show correct marker in full mode, or in exam+key mode
        if (c.correct && (!examReady || showAnswerKey)) {
          runs.push(new TextRun({ text: '  ✓', bold: true, color: '2e7d32', size: 20 }));
        }
        qChildren.push(new Paragraph({ keepNext: true, indent: { left: 360 }, children: runs }));
      }
    }

    // Matching pairs
    else if (q.questionType === 'MATCHING' && q.pairs?.length) {
      if (examReady && !showAnswerKey) {
        // Exam mode: show prompts on left, shuffled answer pool on right (not paired)
        const prompts = q.pairs.map(p => p.left);
        const answers = [...q.pairs.map(p => p.right)].sort(() => Math.random() - 0.5);
        const rowCount = Math.max(prompts.length, answers.length);
        const tRows = [];
        for (let ri = 0; ri < rowCount; ri++) {
          tRows.push(new TableRow({
            children: [
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: prompts[ri] || '', size: 20 })] })],
              }),
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: answers[ri] || '', size: 20 })] })],
              }),
            ],
          }));
        }
        qChildren.push(new Table({ rows: tRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      } else {
        // Full mode: paired with arrows
        const tRows = q.pairs.map(p => new TableRow({
          children: [
            new TableCell({
              width: { size: 45, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: p.left, size: 20 })] })],
            }),
            new TableCell({
              width: { size: 10, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '\u2192', size: 20 })] })],
            }),
            new TableCell({
              width: { size: 45, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: p.right, size: 20 })] })],
            }),
          ],
        }));
        qChildren.push(new Table({ rows: tRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      }
    }

    // FIB
    else if (q.questionType === 'BLANKS') {
      if (!examReady || showAnswerKey) {
        const answers = (q.correctValues || []).join('; ');
        if (answers) {
          qChildren.push(new Paragraph({
            indent: { left: 360 },
            children: [
              new TextRun({ text: 'Answers: ', bold: true, size: 20, color: showAnswerKey ? '2e7d32' : undefined }),
              new TextRun({ text: answers, size: 20, color: showAnswerKey ? '2e7d32' : undefined }),
            ],
          }));
        }
      }
      // Exam mode without key: blanks are already in the prompt text as ___
    }

    // Short answer
    else if (q.questionType === 'SHORT') {
      if (examReady && !showAnswerKey) {
        // Show blank lines for student to write
        qChildren.push(new Paragraph({ indent: { left: 360 }, spacing: { before: 200 }, children: [new TextRun({ text: '________________________________________', color: 'CCCCCC', size: 20 })] }));
      } else {
        const answers = (q.correctValues || []).join('; ');
        if (answers) {
          qChildren.push(new Paragraph({
            indent: { left: 360 },
            children: [new TextRun({ text: 'Key terms: ', bold: true, size: 20 }), new TextRun({ text: answers, size: 20 })],
          }));
        }
      }
    }

    // Feedback — only in full mode
    if (!examReady && q.feedback) {
      qChildren.push(new Paragraph({
        indent: { left: 360 },
        spacing: { before: 80 },
        children: [
          new TextRun({ text: 'Explanation: ', bold: true, italics: true, size: 18, color: '555555' }),
          new TextRun({ text: q.feedback, italics: true, size: 18, color: '555555' }),
        ],
      }));
    }

    // Separator
    qChildren.push(new Paragraph({
      spacing: { before: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' } },
      children: [],
    }));

    children.push(...qChildren);
  } // end questions loop
  } // end sections loop

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } },
      },
      children,
    }],
  });

  return await Packer.toBlob(doc);
}

function downloadFile(content, filename, mimeType) {
  const blob = content instanceof Blob
    ? content
    : content instanceof ArrayBuffer || content instanceof Uint8Array
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

// ── Extract questions from assessment edit page (Apollo cache) ───────────────
async function extractAssessmentQuestions() {
  const tabId = cadmusTabId;
  if (!tabId) throw new Error('No Cadmus tab found');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (!window.__APOLLO_CLIENT__) return { error: 'Apollo Client not found — is the assessment page fully loaded?' };
      const cache = window.__APOLLO_CLIENT__.cache.extract();

      const assessmentId = window.location.href.match(/\/assessment\/([^/?#]+)/)?.[1];
      if (!assessmentId) return { error: 'Could not extract assessmentId from URL' };

      const rootKeys = Object.keys(cache['ROOT_QUERY'] || {});
      // Prefer INDIVIDUAL, then GROUP, then any task query containing the assessmentId
      const taskKey = rootKeys.find(k => k.includes('"kind":"INDIVIDUAL"') && k.includes(assessmentId))
        || rootKeys.find(k => k.includes('"kind":"GROUP"') && k.includes(assessmentId))
        || rootKeys.find(k => k.includes(assessmentId) && (k.startsWith('task(') || k.startsWith('taskByAssessment(')));
      if (!taskKey) return { error: 'No task found in cache for this assessment — ensure the page is fully loaded' };

      const taskRef = cache['ROOT_QUERY'][taskKey]?.__ref;
      if (!taskRef) return { error: 'Task reference not found in cache' };
      const task = cache[taskRef];
      if (!task?.blocks) return { error: 'Task has no blocks' };

      // Resolve assessment name: task object fields → page title fallback
      const assessmentName = task.name || task.title
        || cache[task.assessment?.__ref]?.name
        || cache[task.assessment?.__ref]?.title
        || document.title.replace(/\s*[-|].*$/, '').trim()
        || '';

      // Helper: extract plain text from a ProseMirror JSON doc
      const extractDocText = (raw) => {
        try {
          const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const texts = [];
          const walk = (nodes) => {
            for (const n of (nodes || [])) {
              if (n.type === 'text' && n.text) texts.push(n.text);
              if (n.content) walk(n.content);
            }
          };
          walk(doc?.content);
          return texts.join('').trim();
        } catch (_) { return ''; }
      };

      const questions = [];
      let sectionTitle = '';
      let sectionIndex = 0;

      for (const bRef of task.blocks) {
        const block = cache[bRef.__ref];
        if (!block || block.deleted || block.hidden) continue;
        const q = block.question ? cache[block.question.__ref] : null;
        if (!q) continue;

        if (q.questionType === 'OVERVIEW') continue;

        if (q.questionType === 'SECTION') {
          sectionIndex++;
          sectionTitle = q.shortPrompt
            || extractDocText(q.body?.promptDoc)
            || `Part ${sectionIndex}`;
          continue;
        }

        // Resolve tag names from refs
        const tags = (q.tags || [])
          .map(ref => cache[ref?.__ref]?.name).filter(Boolean);

        questions.push({
          blockId: block.id,
          points: block.points ?? q.points,
          id: q.id,
          questionType: q.questionType,
          shortPrompt: q.shortPrompt,
          body: q.body,
          difficulty: q.difficulty || '',
          tags,
          sectionTitle,
          sectionIndex,
        });
      }

      return { questions, assessmentName, source: window.location.href };
    },
  });

  return result.result;
}

function normaliseAssessmentQuestion(raw, index) {
  const body = raw.body || {};
  const field = body.fields?.[0];
  const inter = field?.interaction;

  // Extract prompt text from ProseMirror JSON
  let prompt = raw.shortPrompt || '';
  try {
    const doc = typeof body.promptDoc === 'string' ? JSON.parse(body.promptDoc) : body.promptDoc;
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
      prompt = texts.join('').trim() || prompt;
    }
  } catch (_) {}

  const q = {
    index: index + 1,
    id: raw.id,
    questionType: raw.questionType,
    prompt,
    feedback: body.feedback || '',
    points: raw.points ?? 1,
    difficulty: raw.difficulty || '',
    tags: raw.tags || [],
    sectionTitle: raw.sectionTitle || '',
    sectionIndex: raw.sectionIndex || 0,
    correctValues: field?.response?.correctValues || [],
  };

  // MCQ choices
  if (inter?.__typename === 'ChoiceInteraction') {
    q.choices = (inter.choices || []).map(c => ({
      text: c.content,
      correct: (field.response?.correctValues || []).includes(c.identifier),
    }));
  }

  // Matching pairs
  if (inter?.__typename === 'MatchInteraction') {
    const sources = inter.sourceSet || [];
    const targets = inter.targetSet || [];
    q.pairs = [];
    for (const cv of (field.response?.correctValues || [])) {
      const parts = cv.split(' ');
      if (parts.length === 2) {
        const tgt = targets.find(t => t.identifier === parts[0]);
        const src = sources.find(s => s.identifier === parts[1]);
        if (tgt && src) q.pairs.push({ left: tgt.content, right: src.content });
      }
    }
  }

  return q;
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
  // Live re-render report charts when SC toggle changes
  if (toggle.id === 'report-split-sc' && window._reportData) renderReport();
});

// Re-render last active report when grouping dropdown changes
document.getElementById('analysis-grouping')?.addEventListener('change', () => {
  const model = window._analysisModel;
  const renderer = window._lastReportRenderer;
  if (!model || !renderer) return;
  const output = document.getElementById('report-output');
  output.innerHTML = '';
  renderer(output, model);
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
    case 'checkMatchingBalance':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Checking matching question balance (prompts vs answers)…');
        const result = await runAction('checkMatchingBalance', {});
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'fixFIB':
      // Fix FIB questions — reduce to 1 correct answer per blank
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Fixing fill-in-blank questions — reducing to 1 correct answer per blank…');
        const result = await runAction('fixFIBQuestions', {});
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'editShort':
      options = { points: parseFloat($('#short-points').value), similarity: parseInt($('#short-similarity').value, 10) };
      break;
    case 'gradingLoadData':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Loading assessment data (question bodies + work outcomes)…');
        const result = await runAction('gradingLoadData', {});
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        if (result?.success) {
          const summary = document.getElementById('grading-load-summary');
          summary.innerHTML = `<strong>${result.students}</strong> students | <strong>${result.blanksQuestions}</strong> BLANKS Qs (${result.blanksFields} fields, <span style="color:#d32f2f">${result.fixCandidates} penalised</span>) | <strong>${result.shortQuestions}</strong> SHORT Qs (${result.shortFields} rows)`;
          summary.style.display = 'block';
          // Unlock BLANKS card
          const blanksCard = document.getElementById('card-grading-blanks');
          if (blanksCard) { blanksCard.style.opacity = '1'; blanksCard.style.pointerEvents = 'auto'; }
          // Show BLANKS summary + export button
          const blanksSummary = document.getElementById('grading-blanks-summary');
          if (blanksSummary && result.fixCandidates > 0) {
            blanksSummary.innerHTML = `<strong>${result.fixCandidates}</strong> field(s) where student gave a correct answer but scored &lt;1 due to partial scoring`;
            blanksSummary.style.display = 'block';
          }
          document.getElementById('btn-export-blanks-csv').style.display = '';
          // Unlock SHORT card
          const shortCard = document.getElementById('card-grading-short');
          if (shortCard) { shortCard.style.opacity = '1'; shortCard.style.pointerEvents = 'auto'; }
          // Populate SHORT model answer mapping table
          if (result.shortModelAnswers) {
            populateShortMappingTable(result.shortModelAnswers);
          }
          // Show SHORT summary
          const shortSummary = document.getElementById('grading-short-summary');
          if (shortSummary) {
            const missing = (result.shortModelAnswers || []).filter(q => !q.hasAnswer).length;
            shortSummary.innerHTML = `<strong>${result.shortFields}</strong> responses across <strong>${result.shortQuestions}</strong> questions` +
              (missing > 0 ? ` | <span style="color:#d32f2f">${missing} missing model answer(s)</span>` : ' | all model answers available');
            shortSummary.style.display = 'block';
          }
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'gradingExportBlanksCsv':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Building BLANKS audit CSV…');
        const result = await runAction('gradingExportBlanksCsv', {});
        if (result?.error) { logError(result.error); }
        else if (result?.csv) {
          const ts = new Date().toISOString().slice(0, 10);
          downloadFile(result.csv, `cadmus_blanks_audit_${ts}.csv`, 'text/csv');
          log(`Exported ${result.rows} rows`, 'ok');
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'gradingFixBlanks':
      (async () => {
        const dryRun = isToggleOn('grading-dry-run');
        if (!dryRun && !confirm('Apply score fixes? This will modify student scores directly via MarkFieldOutcome.')) return;
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log(dryRun ? 'DRY RUN — previewing BLANKS fixes…' : 'Applying BLANKS score fixes…');
        const result = await runAction('gradingFixBlanks', { dryRun });
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        if (!dryRun && result?.success) {
          document.getElementById('btn-export-updated-csv').style.display = '';
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'gradingExportUpdatedCsv':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Re-fetching work outcomes and building updated CSV…');
        const result = await runAction('gradingExportUpdatedCsv', {});
        if (result?.error) { logError(result.error); }
        if (result?.logs) result.logs.forEach(l => log(l.msg, l.cls));
        if (result?.csv) {
          const ts = new Date().toISOString().slice(0, 10);
          downloadFile(result.csv, `cadmus_blanks_updated_${ts}.csv`, 'text/csv');
          log(`Exported ${result.rows} updated rows`, 'ok');
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'gradingExportShortCsv':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Building SHORT answers CSV…');
        const result = await runAction('gradingExportShortCsv', { uploadedAnswers: window.__gradingUploadedAnswers || {} });
        if (result?.error) { logError(result.error); }
        else if (result?.csv) {
          const ts = new Date().toISOString().slice(0, 10);
          downloadFile(result.csv, `cadmus_short_answers_${ts}.csv`, 'text/csv');
          log(`Exported ${result.rows} rows`, 'ok');
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'chartDistribution':
    case 'chartGrades':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Scanning grades…');
        try {
          const entries = await scrapeGrades();
          if (!entries || !entries.length) { log('No grades found — is the marking/moderation view open?', 'err'); return; }
          // Prefer maxMark from cache; fall back to highest actual mark seen; then manual input
          const cacheMax = Math.max(...entries.map(e => e.maxMark || 0));
          const markCeil = Math.ceil(Math.max(...entries.map(e => e.mark || 0)));
          const detectedMax = cacheMax || markCeil || parseInt($('#report-max').value, 10) || 50;
          $('#report-max').value = detectedMax;
          const hasAdj = entries.some(e => e.adj != null && e.adj !== 0);
          const scCount = entries.filter(e => e.specialCon).length;
          const src = hasAdj ? 'Apollo cache' : 'DOM';
          log(`Found ${entries.length} submissions (max ${detectedMax}${scCount ? `, ${scCount} special con.` : ''}${hasAdj ? ', with adjustments' : ''}) [${src}]`, 'ok');
          // Store scraped data for live re-rendering on toggle change
          window._reportData = { entries, maxMarks: detectedMax, chartType: action };
          renderReport();
        } catch (err) {
          log(`Chart failed: ${err.message}`, 'err');
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
    case 'reportGroupComparison':
    case 'reportBlooms':
    case 'reportTopic':
    case 'reportDifficulty':
    case 'reportQuestionType':
    case 'reportTiming':
    case 'reportAutomark':
      (async () => {
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        log('Loading analysis data from Apollo cache…');
        try {
          const data = await loadAnalysisData();
          if (!data) { log('Apollo cache not found — is the Cadmus page fully loaded?', 'err'); return; }
          log(`Loaded: ${data.workOutcomes.length} students, ${data.questions.length} questions, ${data.accessCodes.length} access codes`, 'ok');
          const model = buildAnalysisModel(data);

          // Populate grouping dropdown — always keep "Full cohort" as first option
          const groupSel = document.getElementById('analysis-grouping');
          if (groupSel) {
            const currentVal = groupSel.value;
            groupSel.innerHTML = '<option value="">Full cohort (no grouping)</option>';
            model.groupings.forEach(g => {
              const opt = document.createElement('option');
              opt.value = g.id; opt.textContent = g.label;
              groupSel.appendChild(opt);
            });
            // Restore previous selection only if it's still a valid dimension
            if (currentVal && model.groupings.some(g => g.id === currentVal)) {
              groupSel.value = currentVal;
            } else {
              groupSel.value = '';
            }
          }

          // Store model and last renderer for re-use on grouping change
          window._analysisModel = model;

          const output = document.getElementById('report-output');
          output.innerHTML = '';
          const renderers = {
            reportGroupComparison: renderGroupComparisonReport,
            reportBlooms: renderBloomsReport,
            reportTopic: renderTopicReport,
            reportDifficulty: renderDifficultyReport,
            reportQuestionType: renderQuestionTypeReport,
            reportTiming: renderTimingReport,
            reportAutomark: renderAutomarkReport,
          };
          window._lastReportRenderer = renderers[action];
          renderers[action](output, model);
        } catch (err) {
          log(`Report failed: ${err.message}`, 'err');
          console.error(err);
        }
        document.querySelectorAll('.btn').forEach(b => b.disabled = false);
      })();
      return;
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
        const isAssessment = document.body.dataset.context === 'assessment';

        let data;
        let assessmentName = '';
        if (isAssessment) {
          // Assessment edit page: extract from Apollo cache
          if (progress) { progress.style.display = 'block'; progress.textContent = 'Reading assessment data from cache\u2026'; }
          log('Extracting questions from assessment page\u2026');
          const raw = await extractAssessmentQuestions();
          if (progress) progress.style.display = 'none';
          if (!raw || raw.error) {
            log(raw?.error || 'Extraction failed', 'err');
            document.querySelectorAll('.btn').forEach(b => b.disabled = false);
            return;
          }
          assessmentName = raw.assessmentName || '';
          data = {
            source: raw.source,
            totalQuestions: raw.questions.length,
            questions: raw.questions.map((q, i) => normaliseAssessmentQuestion(q, i)),
          };
          log(`Found ${data.questions.length} questions in assessment`, 'ok');
        } else {
          // Library page: use existing GraphQL export
          if (progress) { progress.style.display = 'block'; progress.textContent = 'Fetching question data\u2026'; }
          log(`Exporting ${scope} questions as ${fmt.toUpperCase()}\u2026`);
          const result = await runAction('exportQuestions', { scope });
          if (progress) progress.style.display = 'none';
          if (!result || result.error) {
            document.querySelectorAll('.btn').forEach(b => b.disabled = false);
            return;
          }
          data = result;
        }

        const dummy = null; // keep the rest of the export code unchanged below
        if (!data.questions?.length) {
          log('No questions to export', 'err');
          document.querySelectorAll('.btn').forEach(b => b.disabled = false);
          return;
        }

        // Build filename
        const ts = new Date().toISOString().slice(0, 10);
        const assessmentSlug = assessmentName
          .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const baseName = assessmentSlug
          ? `cadmus_${assessmentSlug}_${ts}`
          : `cadmus_export_${ts}`;

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
            case 'docx-sorted': {
              const blob = await exportToDocx(data, { randomise: false });
              downloadFile(blob, `${baseName}_by-type.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              break;
            }
            case 'docx-random': {
              const blob = await exportToDocx(data, { randomise: true });
              downloadFile(blob, `${baseName}_randomised.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              break;
            }
            case 'docx-exam': {
              const blob = await exportToDocx(data, { randomise: true, examReady: true });
              downloadFile(blob, `${baseName}_exam.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              break;
            }
            case 'docx-exam-key': {
              const blob = await exportToDocx(data, { randomise: true, examReady: true, showAnswerKey: true });
              downloadFile(blob, `${baseName}_exam-key.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              break;
            }
            case 'docx-exam-full': {
              const blob = await exportToDocx(data, { randomise: true });
              downloadFile(blob, `${baseName}_exam-full.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              break;
            }
          }
          const extMap = { qti: 'xml', 'docx-sorted': 'docx (by type)', 'docx-random': 'docx (randomised)', 'docx-exam': 'docx (exam ready)', 'docx-exam-key': 'docx (exam + key)', 'docx-exam-full': 'docx (exam full)' };
          log(`Exported ${data.questions.length} question(s) as ${baseName}.${extMap[fmt] || fmt}`, 'ok');
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

// ── Grading: SHORT answer model answer table + upload ────────────────────────

function populateShortMappingTable(questions) {
  const tbody = document.querySelector('#grading-short-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const q of questions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${q.questionNo}</td>` +
      `<td title="${q.prompt}">${q.prompt}</td>` +
      `<td title="${q.modelAnswer}">${q.modelAnswer || '—'}</td>` +
      `<td class="${q.hasAnswer ? 'grading-status-ok' : 'grading-status-missing'}">${q.hasAnswer ? 'OK' : 'Missing'}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('grading-short-mapping').style.display = '';
}

// Upload model answers CSV/Excel to fill missing model answers
document.getElementById('grading-upload-answers')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      let rows;
      if (file.name.endsWith('.csv')) {
        // Parse CSV
        const text = ev.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        rows = lines.slice(1).map(line => {
          const vals = line.match(/(".*?"|[^,]*)/g) || [];
          const obj = {};
          headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
          return obj;
        });
      } else {
        // Parse Excel
        const data = new Uint8Array(ev.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws);
      }

      // Build uploaded answers map: QuestionNo → ExpectedAnswer
      const uploaded = {};
      let matched = 0;
      for (const row of rows) {
        const qno = row['QuestionNo'] || row['#'] || row['questionNo'];
        const answer = row['ExpectedAnswer'] || row['ModelAnswer'] || row['Expected Answer'] || row['Model Answer'] || row['Answer'];
        if (qno && answer) {
          uploaded[String(qno).trim()] = answer.trim();
          matched++;
        }
      }

      // Store for use by export actions
      if (!window.__gradingUploadedAnswers) window.__gradingUploadedAnswers = {};
      Object.assign(window.__gradingUploadedAnswers, uploaded);

      // Update the mapping table to reflect uploads
      const tableRows = document.querySelectorAll('#grading-short-table tbody tr');
      for (const tr of tableRows) {
        const qno = tr.cells[0].textContent;
        if (uploaded[qno]) {
          tr.cells[2].textContent = uploaded[qno].substring(0, 150);
          tr.cells[2].title = uploaded[qno];
          tr.cells[3].textContent = 'Uploaded';
          tr.cells[3].className = 'grading-status-ok';
        }
      }

      log(`Loaded ${matched} model answer(s) from ${file.name}`, 'ok');
    } catch (err) {
      log(`Upload failed: ${err.message}`, 'err');
    }
  };

  if (file.name.endsWith('.csv')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
});

// ── Grade scraping + chart rendering ─────────────────────────────────────────

async function scrapeGrades() {
  const tabId = cadmusTabId;
  if (!tabId) throw new Error('No Cadmus tab found');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const cache = window.__APOLLO_CLIENT__?.cache?.extract();
      if (!cache) return [];

      // Build enrollment lookup: workId → { specialCon }
      const enrollMeta = {};
      Object.values(cache).forEach(v => {
        if (v?.__typename !== 'Enrollment' || v.deleted) return;
        const workId = v.work?.__ref?.replace('Work:', '') || v.workId;
        if (!workId) return;
        // Check for special consideration flags in the enrollment or its tags
        const tags = v.tags || [];
        const specialCon = tags.some(t => /special\s*con/i.test(typeof t === 'string' ? t : t?.name || ''));
        enrollMeta[workId] = { specialCon };
      });

      const entries = [];
      Object.values(cache).forEach(v => {
        if (v?.__typename !== 'WorkOutcome') return;
        const sb = v.scoreBreakdown;
        if (!sb || sb.score == null) return;
        const meta = enrollMeta[v.workId] || {};
        entries.push({
          mark: sb.score,
          maxMark: v.maxScore ?? 0,
          automark: sb.automark ?? 0,
          markerModifier: sb.markerModifier ?? 0,
          moderatorModifier: sb.moderatorModifier ?? 0,
          adj: (sb.markerModifier ?? 0) + (sb.moderatorModifier ?? 0),
          specialCon: meta.specialCon || false,
        });
      });
      return entries;
    },
  });
  return result.result || [];
}

// Grade band definitions (Australian scale)
const GRADE_BANDS = [
  { label: 'F',   name: 'Fail',             min: 0,  color: '#c62828' },
  { label: 'P',   name: 'Pass',             min: 50, color: '#ef6c00' },
  { label: 'CR',  name: 'Credit',           min: 65, color: '#f9a825' },
  { label: 'D',   name: 'Distinction',      min: 75, color: '#2e7d32' },
  { label: 'HD',  name: 'High Distinction', min: 85, color: '#1565c0' },
];

function gradeFor(mark, maxMarks) {
  const pct = (mark / maxMarks) * 100;
  for (let i = GRADE_BANDS.length - 1; i >= 0; i--) {
    if (pct >= GRADE_BANDS[i].min) return GRADE_BANDS[i];
  }
  return GRADE_BANDS[0];
}

function computeStats(marks) {
  if (!marks.length) return { mean: 0, median: 0, min: 0, max: 0, sorted: [] };
  const r2 = v => parseFloat(v.toFixed(2));
  const sorted = [...marks].sort((a, b) => a - b);
  const mean = r2(marks.reduce((s, v) => s + v, 0) / marks.length);
  const median = r2(sorted[Math.floor(sorted.length / 2)]);
  return { mean, median, min: r2(sorted[0]), max: r2(sorted[sorted.length - 1]), sorted };
}

function lightenColor(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.min(255, Math.round(r + (255 - r) * amount))},${Math.min(255, Math.round(g + (255 - g) * amount))},${Math.min(255, Math.round(b + (255 - b) * amount))})`;
}

function addCopyButton(container, canvas) {
  const btn = document.createElement('button');
  btn.textContent = 'Copy chart';
  btn.style.cssText = 'margin-top:8px;padding:4px 14px;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;color:#555;';
  btn.addEventListener('click', async () => {
    try {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy chart'; }, 1500);
    } catch (_) {
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy chart'; }, 1500);
    }
  });
  container.appendChild(btn);
}

function renderReport() {
  const { entries, maxMarks, chartType } = window._reportData || {};
  if (!entries) return;
  const splitSC = isToggleOn('report-split-sc');
  const output = document.getElementById('report-output');
  output.innerHTML = '';
  if (chartType === 'chartDistribution') {
    renderDistributionChart(output, entries, maxMarks, splitSC);
  } else {
    renderGradeBreakdownChart(output, entries, maxMarks, splitSC);
  }
}

function fmtCountPct(count, total) {
  return `${count} (${((count / total) * 100).toFixed(0)}%)`;
}

function renderDistributionChart(container, entries, maxMarks, splitSC) {
  const hasAdj = entries.some(e => e.adj != null && e.adj !== 0);
  const allMarks = entries.map(e => e.mark);
  const total = entries.length;
  const stats = computeStats(allMarks);
  const scCount = entries.filter(e => e.specialCon).length;

  // Automark-only scores (before adjustments)
  const autoMarks = hasAdj ? entries.map(e => e.automark ?? (e.mark - (e.adj || 0))) : null;
  const autoStats = autoMarks ? computeStats(autoMarks) : null;

  // Build frequency buckets — original scores
  const freqAll = {}, freqReg = {}, freqSC = {};
  for (let i = 0; i <= maxMarks; i++) { freqAll[i] = 0; freqReg[i] = 0; freqSC[i] = 0; }
  for (const e of entries) {
    if (e.mark >= 0 && e.mark <= maxMarks) {
      const bin = Math.round(e.mark);
      freqAll[bin]++;
      if (e.specialCon) freqSC[bin]++; else freqReg[bin]++;
    }
  }

  // Build automark frequency buckets (pre-adjustment) if available
  const freqAuto = {};
  if (hasAdj) {
    for (let i = 0; i <= maxMarks; i++) freqAuto[i] = 0;
    for (const e of entries) {
      const pre = e.automark ?? (e.mark - (e.adj || 0));
      const bin = Math.max(0, Math.min(maxMarks, Math.round(pre)));
      freqAuto[bin]++;
    }
  }

  // Merge label sets from both distributions
  const labelSet = new Set(Object.keys(freqAll).map(Number).filter(k => freqAll[k] > 0));
  if (hasAdj) Object.keys(freqAuto).map(Number).filter(k => freqAuto[k] > 0).forEach(k => labelSet.add(k));
  const labels = [...labelSet].sort((a, b) => a - b);

  const peakCount = hasAdj
    ? Math.max(...labels.map(k => Math.max(freqAll[k] || 0, freqAuto[k] || 0)), 1)
    : Math.max(...labels.map(k => splitSC ? Math.max(freqReg[k], freqSC[k]) : freqAll[k]), 1);

  // Title
  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:2px;color:#1a1a2e;';
  title.textContent = `Mark Distribution — ${total} submissions (out of ${maxMarks} marks)`;

  // Stats lines
  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'font-size:12px;color:#666;margin-bottom:4px;';
  if (hasAdj) {
    statsEl.textContent = `After Adj  →  Mean: ${stats.mean}  |  Median: ${stats.median}  |  Min: ${stats.min}  |  Max: ${stats.max}`;
  } else {
    let statsText = `Mean: ${stats.mean}  |  Median: ${stats.median}  |  Min: ${stats.min}  |  Max: ${stats.max}`;
    if (scCount > 0) statsText += `  |  Special Con: ${scCount}`;
    statsEl.textContent = statsText;
  }

  const statsEls = [statsEl];
  if (hasAdj) {
    const autoEl = document.createElement('div');
    autoEl.style.cssText = 'font-size:12px;color:#666;margin-bottom:4px;';
    autoEl.textContent = `Automark   →  Mean: ${autoStats.mean}  |  Median: ${autoStats.median}  |  Min: ${autoStats.min}  |  Max: ${autoStats.max}`;
    statsEls.push(autoEl);

    const adjVals = entries.map(e => e.adj || 0);
    const adjStats = computeStats(adjVals);
    const adjEl = document.createElement('div');
    adjEl.style.cssText = 'font-size:12px;color:#b07020;margin-bottom:12px;';
    adjEl.textContent = `Adjustments →  Mean: ${adjStats.mean}  |  Median: ${adjStats.median}  |  Min: ${adjStats.min}  |  Max: ${adjStats.max}`;
    statsEls.push(adjEl);
  }

  // Canvas
  const slotW = (hasAdj || splitSC) ? Math.max(18, Math.min(40, Math.floor(600 / labels.length))) : Math.max(14, Math.min(32, Math.floor(580 / labels.length)));
  const canvas = document.createElement('canvas');
  canvas.width = labels.length * slotW + 60;
  canvas.height = 270;
  const ctx = canvas.getContext('2d');
  const [padL, padB, padT] = [36, 36, 20];
  const chartW = canvas.width - padL - 10;
  const chartH = canvas.height - padB - padT;

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i <= 5; i++) {
    const y = padT + chartH - (i / 5) * chartH;
    ctx.strokeStyle = '#dde'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 5) * peakCount), padL - 4, y + 3);
  }

  labels.forEach((label, i) => {
    const x = padL + i * slotW;
    const band = gradeFor(label, maxMarks);

    if (hasAdj) {
      // Overlay mode: automark (orange outline behind) + final score (solid blue front)
      const autoCount = freqAuto[label] || 0;
      if (autoCount > 0) {
        const barH = (autoCount / peakCount) * chartH;
        const y = padT + chartH - barH;
        ctx.fillStyle = 'rgba(244, 167, 66, 0.35)';
        ctx.fillRect(x + 1, y, slotW - 2, barH);
        ctx.strokeStyle = '#f4a742'; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1, y, slotW - 2, barH);
      }
      const finalCount = freqAll[label] || 0;
      if (finalCount > 0) {
        const barH = (finalCount / peakCount) * chartH;
        const y = padT + chartH - barH;
        ctx.fillStyle = 'rgba(91, 155, 213, 0.75)';
        ctx.fillRect(x + 3, y, slotW - 6, barH);
      }
      // Count label
      const topCount = Math.max(autoCount, finalCount);
      if (topCount > 0) {
        const topY = padT + chartH - (topCount / peakCount) * chartH;
        ctx.fillStyle = '#333'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
        if (autoCount !== finalCount) {
          ctx.fillText(`${autoCount}\u2192${finalCount}`, x + slotW / 2, topY - 2);
        } else {
          ctx.fillText(finalCount, x + slotW / 2, topY - 2);
        }
      }
    } else if (splitSC) {
      const halfW = (slotW - 2) / 2;
      const regCount = freqReg[label];
      const regH = (regCount / peakCount) * chartH;
      const regY = padT + chartH - regH;
      ctx.fillStyle = band.color;
      ctx.fillRect(x + 1, regY, halfW, regH);
      if (regCount > 0) {
        ctx.fillStyle = '#333'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(regCount, x + 1 + halfW / 2, regY - 2);
      }
      const scCnt = freqSC[label];
      const scH = (scCnt / peakCount) * chartH;
      const scY = padT + chartH - scH;
      ctx.fillStyle = lightenColor(band.color, 0.45);
      ctx.fillRect(x + 1 + halfW, scY, halfW, scH);
      if (scCnt > 0) {
        ctx.fillStyle = '#333'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(scCnt, x + 1 + halfW + halfW / 2, scY - 2);
      }
    } else {
      const count = freqAll[label];
      const barH = (count / peakCount) * chartH;
      const y = padT + chartH - barH;
      ctx.fillStyle = band.color;
      ctx.fillRect(x + 1, y, slotW - 2, barH);
      if (count > 0) {
        ctx.fillStyle = '#333'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(count, x + slotW / 2, y - 2);
      }
    }

    ctx.fillStyle = '#555'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, x + slotW / 2, padT + chartH + 13);
  });

  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + chartH + 1); ctx.lineTo(padL + chartW, padT + chartH + 1); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`Mark (out of ${maxMarks} marks)`, padL + chartW / 2, canvas.height - 2);
  ctx.save(); ctx.translate(10, padT + chartH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('# Students', 0, 0); ctx.restore();

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:11px;';
  if (hasAdj) {
    legend.innerHTML = '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:14px;height:14px;background:rgba(91,155,213,0.75);border-radius:2px;display:inline-block"></span> Final Score</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:14px;height:14px;background:rgba(244,167,66,0.35);border:1.5px solid #f4a742;border-radius:2px;display:inline-block;box-sizing:border-box"></span> Automark (pre-adj)</span>';
  } else {
    for (const band of GRADE_BANDS) {
      const item = document.createElement('span');
      item.innerHTML = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${band.color};vertical-align:-1px;margin-right:3px"></span>${band.label} (${band.min}%+)`;
      legend.appendChild(item);
    }
    if (splitSC) {
      legend.innerHTML += `<span style="margin-left:6px">|</span><span><b style="margin-right:3px">■</b>Regular</span><span><b style="color:#bbb;margin-right:3px">■</b>Special Con.</span>`;
    }
  }

  container.appendChild(title);
  statsEls.forEach(el => container.appendChild(el));
  container.appendChild(canvas);
  container.appendChild(legend);
  addCopyButton(container, canvas);
}

function renderGradeBreakdownChart(container, entries, maxMarks, splitSC) {
  const hasAdj = entries.some(e => e.adj != null && e.adj !== 0);
  const allMarks = entries.map(e => e.mark);
  const total = entries.length;
  const stats = computeStats(allMarks);
  const scTotal = entries.filter(e => e.specialCon).length;
  const regTotal = total - scTotal;

  // Final score buckets
  const buckets = GRADE_BANDS.map(b => ({ ...b, reg: 0, sc: 0, all: 0, auto: 0 }));
  for (const e of entries) {
    const band = gradeFor(e.mark, maxMarks);
    const bucket = buckets.find(b => b.label === band.label);
    bucket.all++;
    if (e.specialCon) bucket.sc++; else bucket.reg++;
  }

  // Automark buckets (pre-adjustment)
  if (hasAdj) {
    for (const e of entries) {
      const pre = e.automark ?? (e.mark - (e.adj || 0));
      const band = gradeFor(pre, maxMarks);
      const bucket = buckets.find(b => b.label === band.label);
      bucket.auto++;
    }
  }

  const peakVal = hasAdj
    ? Math.max(...buckets.map(b => Math.max(b.all, b.auto)), 1)
    : Math.max(...buckets.map(b => splitSC ? Math.max(b.reg, b.sc) : b.all), 1);

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:2px;color:#1a1a2e;';
  title.textContent = `Grade Breakdown — ${total} submissions` + (scTotal > 0 ? ` (${scTotal} special con.)` : '');

  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'font-size:12px;color:#666;margin-bottom:12px;';
  statsEl.textContent = `Mean: ${stats.mean}  |  Median: ${stats.median}  |  Min: ${stats.min}  |  Max: ${stats.max}`;

  const bandW = (hasAdj || splitSC) ? 110 : 80;
  const canvas = document.createElement('canvas');
  canvas.width = buckets.length * bandW + 60;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const [padL, padT] = [36, 24];
  const barH = 160;
  const chartW = canvas.width - padL - 10;

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const y = padT + barH - (i / 4) * barH;
    ctx.strokeStyle = '#dde'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * peakVal), padL - 4, y + 3);
  }

  buckets.forEach((bucket, i) => {
    const x = padL + i * bandW;

    if (hasAdj) {
      const halfW = (bandW - 16) / 2;
      // Automark (orange, left)
      const autoH = bucket.auto > 0 ? (bucket.auto / peakVal) * barH : 0;
      const autoY = padT + barH - autoH;
      ctx.fillStyle = 'rgba(244, 167, 66, 0.55)';
      ctx.fillRect(x + 8, autoY, halfW, autoH);
      if (bucket.auto > 0) {
        ctx.fillStyle = '#333'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(fmtCountPct(bucket.auto, total), x + 8 + halfW / 2, autoY - 3);
      }
      // Final (blue, right)
      const finalH = bucket.all > 0 ? (bucket.all / peakVal) * barH : 0;
      const finalY = padT + barH - finalH;
      ctx.fillStyle = 'rgba(91, 155, 213, 0.75)';
      ctx.fillRect(x + 8 + halfW, finalY, halfW, finalH);
      if (bucket.all > 0) {
        ctx.fillStyle = '#333'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(fmtCountPct(bucket.all, total), x + 8 + halfW + halfW / 2, finalY - 3);
      }
    } else if (splitSC) {
      const halfW = (bandW - 16) / 2;
      const regH = bucket.reg > 0 ? (bucket.reg / peakVal) * barH : 0;
      const regY = padT + barH - regH;
      ctx.fillStyle = bucket.color;
      ctx.fillRect(x + 8, regY, halfW, regH);
      if (bucket.reg > 0) {
        ctx.fillStyle = '#333'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(fmtCountPct(bucket.reg, regTotal), x + 8 + halfW / 2, regY - 3);
      }
      const scH = bucket.sc > 0 ? (bucket.sc / peakVal) * barH : 0;
      const scY = padT + barH - scH;
      ctx.fillStyle = lightenColor(bucket.color, 0.45);
      ctx.fillRect(x + 8 + halfW, scY, halfW, scH);
      if (bucket.sc > 0) {
        ctx.fillStyle = '#333'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(fmtCountPct(bucket.sc, scTotal), x + 8 + halfW + halfW / 2, scY - 3);
      }
    } else {
      const bH = bucket.all > 0 ? (bucket.all / peakVal) * barH : 0;
      const y = padT + barH - bH;
      ctx.fillStyle = bucket.color;
      ctx.fillRect(x + 8, y, bandW - 16, bH);
      if (bucket.all > 0) {
        ctx.fillStyle = '#333'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(fmtCountPct(bucket.all, total), x + bandW / 2, y - 4);
      }
    }

    // Label below
    const labelY = padT + barH + 14;
    ctx.fillStyle = '#333'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(bucket.label, x + bandW / 2, labelY);
    ctx.fillStyle = '#777'; ctx.font = '9px sans-serif';
    const rangeText = bucket.min === 0 ? '<50%' : `${bucket.min}–${bucket.min === 85 ? '100' : (bucket.min + 9)}%`;
    ctx.fillText(rangeText, x + bandW / 2, labelY + 13);
  });

  // Axes
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + barH + 1); ctx.lineTo(padL + chartW, padT + barH + 1); ctx.stroke();
  ctx.save(); ctx.translate(10, padT + barH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('# Students', 0, 0); ctx.restore();

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:11px;';
  if (hasAdj) {
    legend.innerHTML = '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:14px;height:14px;background:rgba(244,167,66,0.55);border-radius:2px;display:inline-block"></span> Automark (pre-adj)</span>' +
      '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:14px;height:14px;background:rgba(91,155,213,0.75);border-radius:2px;display:inline-block"></span> Final Score</span>';
  } else {
    for (const band of GRADE_BANDS) {
      const item = document.createElement('span');
      item.innerHTML = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${band.color};vertical-align:-1px;margin-right:3px"></span>${band.label}`;
      legend.appendChild(item);
    }
    if (splitSC) {
      legend.innerHTML += `<span style="margin-left:6px">|</span><span><b style="margin-right:3px">■</b>Regular (n=${regTotal})</span><span><b style="color:#bbb;margin-right:3px">■</b>Special Con. (n=${scTotal})</span>`;
    }
  }

  container.appendChild(title);
  container.appendChild(statsEl);
  container.appendChild(canvas);
  container.appendChild(legend);
  addCopyButton(container, canvas);
}

// ── Analysis Reports: Data Layer ────────────────────────────────────────────

async function loadAnalysisData() {
  const tabId = cadmusTabId;
  if (!tabId) return null;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const cache = window.__APOLLO_CLIENT__?.cache?.extract();
      if (!cache) return null;

      const byType = {};
      Object.values(cache).forEach(v => {
        if (!v?.__typename) return;
        if (!byType[v.__typename]) byType[v.__typename] = [];
        byType[v.__typename].push(v);
      });

      // Slim down to the fields we need
      const slim = (arr, fields) => (arr || []).map(v => {
        const o = {};
        fields.forEach(f => { if (v[f] !== undefined) o[f] = v[f]; });
        return o;
      });

      return {
        users: slim(byType['User'], ['id', 'name', 'email']),
        enrollments: (byType['Enrollment'] || []).map(e => ({
          id: e.id, deleted: e.deleted, sisUserId: e.sisUserId,
          userId: e.user?.__ref?.replace('User:', ''),
          workId: e.work?.__ref?.replace('Work:', ''),
          accessCodeId: e.accessCode?.__ref?.replace('AccessCode:', ''),
          workSettingsRef: e.workSettings?.__ref?.replace('WorkSettings:', ''),
          tags: e.tags || [],
          verifiedCodes: e.verifiedCodes || [],
        })),
        accessCodes: slim(byType['AccessCode'], ['id', 'label', 'active']),
        workOutcomes: (byType['WorkOutcome'] || []).map(wo => ({
          id: wo.id, workId: wo.workId, maxScore: wo.maxScore,
          score: wo.scoreBreakdown?.score,
          automark: wo.scoreBreakdown?.automark,
          marker: wo.scoreBreakdown?.marker,
          markerModifier: wo.scoreBreakdown?.markerModifier,
          moderatorModifier: wo.scoreBreakdown?.moderatorModifier,
          questionOutcomeRefs: (wo.questionOutcomes || []).map(r => r.__ref?.replace('QuestionOutcome:', '')),
        })),
        questionOutcomes: (byType['QuestionOutcome'] || []).map(qo => ({
          id: qo.id,
          questionId: qo.questionId || qo.question?.__ref?.replace('Question:', ''),
          score: qo.scoreBreakdown?.score,
          automark: qo.scoreBreakdown?.automark,
          markerModifier: qo.scoreBreakdown?.markerModifier,
          maxScore: qo.maxScore,
        })),
        questions: (byType['Question'] || []).map(q => ({
          id: q.id, questionType: q.questionType, difficulty: q.difficulty,
          points: q.points,
          tagRefs: (q.tags || []).map(t => t.__ref?.replace('QuestionTag:', '') || t),
        })),
        questionTags: slim(byType['QuestionTag'], ['id', 'name', 'label', 'value', 'tagType', 'type']),
        works: slim(byType['Work'], ['id', 'startDate', 'lastSaveTime', 'attemptCount']),
        submissions: slim(byType['Submission'], ['id', 'submittedAt', 'forceSubmitted', 'workId']),
        workSettings: (byType['WorkSettings'] || []).map(ws => ({
          id: ws.id, examDeferred: ws.examDeferred,
          examStartDate: ws.examStartDate, examEndDate: ws.examEndDate,
          examWritingTime: ws.examWritingTime,
        })),
        assessmentSettings: (byType['AssessmentSettings'] || []).map(as => ({
          examWritingTime: as.examWritingTime, maxGrade: as.maxGrade,
          weight: as.weight, assessmentType: as.assessmentType,
          examStartDate: as.examStartDate, examEndDate: as.examEndDate,
        })),
      };
    },
  });
  return result.result;
}

function buildAnalysisModel(raw) {
  const userMap = {};
  raw.users.forEach(u => { userMap[u.id] = u; });

  const codeMap = {};
  raw.accessCodes.forEach(c => { codeMap[c.id] = c; });

  const workMap = {};
  raw.works.forEach(w => { workMap[w.id] = w; });

  const wsMap = {};
  raw.workSettings.forEach(ws => { wsMap[ws.id] = ws; });

  const submissionByWork = {};
  raw.submissions.forEach(s => { if (s.workId) submissionByWork[s.workId] = s; });

  const questionMap = {};
  raw.questions.forEach(q => { questionMap[q.id] = q; });

  const tagMap = {};
  raw.questionTags.forEach(t => { tagMap[t.id] = t; });

  const qoMap = {};
  raw.questionOutcomes.forEach(qo => { qoMap[qo.id] = qo; });

  // Build per-student records
  const enrollByWork = {};
  raw.enrollments.filter(e => !e.deleted).forEach(e => { enrollByWork[e.workId] = e; });

  // Use the max across all work outcomes to avoid a null first entry causing wrong fallback
  const maxScore = Math.max(...raw.workOutcomes.map(wo => wo.maxScore || 0))
    || raw.assessmentSettings[0]?.maxGrade
    || Math.ceil(Math.max(...raw.workOutcomes.map(wo => wo.score || 0)))
    || 40;
  const examWritingTime = raw.assessmentSettings[0]?.examWritingTime || 50;

  const students = raw.workOutcomes.map(wo => {
    const enrol = enrollByWork[wo.workId] || {};
    const user = userMap[enrol.userId] || {};
    const work = workMap[wo.workId] || {};
    const sub = submissionByWork[wo.workId];
    const ws = wsMap[enrol.workSettingsRef];

    // Resolve access code label: prefer verifiedCodes (reliable), fall back to accessCode ref
    const verifiedLabel = enrol.verifiedCodes?.[0]?.label;
    let accessCodeLabel = verifiedLabel || null;
    if (!accessCodeLabel && enrol.accessCodeId) {
      // Try direct match, then search by embedded code
      const direct = codeMap[enrol.accessCodeId];
      if (direct) { accessCodeLabel = direct.label; }
      else {
        const codeMatch = enrol.accessCodeId.match(/"code":"([^"]+)"/);
        if (codeMatch) {
          const found = raw.accessCodes.find(c => c.id?.includes(codeMatch[1]));
          if (found) accessCodeLabel = found.label;
        }
      }
    }

    // Resolve enrollment tags as flat strings
    const tagStrings = (enrol.tags || []).map(t => typeof t === 'string' ? t : t?.name || t?.label || JSON.stringify(t)).filter(Boolean);

    return {
      name: user.name || 'Unknown',
      sisId: enrol.sisUserId || '',
      score: wo.score ?? 0,
      maxScore: wo.maxScore || maxScore,
      automark: wo.automark ?? 0,
      markerModifier: wo.markerModifier ?? 0,
      moderatorModifier: wo.moderatorModifier ?? 0,
      adj: (wo.markerModifier ?? 0) + (wo.moderatorModifier ?? 0),
      accessCode: accessCodeLabel,
      deferred: ws?.examDeferred || false,
      deferredWritingTime: ws?.examWritingTime,
      startDate: work.startDate ? new Date(work.startDate) : null,
      submittedAt: sub?.submittedAt ? new Date(sub.submittedAt) : null,
      forceSubmitted: sub?.forceSubmitted || false,
      enrollmentTags: tagStrings,
      questionOutcomeRefs: wo.questionOutcomeRefs || [],
    };
  });

  // Auto-detect available grouping dimensions
  const groupings = detectGroupings(students);

  // Build per-question records with tags
  const questions = raw.questions.filter(q => q.questionType !== 'OVERVIEW').map(q => {
    const tags = (q.tagRefs || []).map(id => tagMap[id]).filter(Boolean);
    const bloomTag = tags.find(t => /remember|understand|apply|analy[sz]e|evaluate|create/i.test(t.name || t.label || t.value || ''));
    const weekTag = tags.find(t => /week|wk/i.test(t.name || t.label || t.value || ''));
    const topicTags = tags.filter(t => t !== bloomTag && t !== weekTag);

    return {
      id: q.id,
      type: q.questionType,
      difficulty: q.difficulty,
      points: q.points ?? 1,
      bloom: bloomTag ? (bloomTag.name || bloomTag.label || bloomTag.value || '').toLowerCase() : null,
      week: weekTag ? (weekTag.name || weekTag.label || weekTag.value || '') : null,
      topics: topicTags.map(t => t.name || t.label || t.value || ''),
    };
  });

  // Build question outcome lookup: questionId → [{score, maxScore, studentIdx}]
  const qOutcomesByQuestion = {};
  students.forEach((s, si) => {
    s.questionOutcomeRefs.forEach(ref => {
      const qo = qoMap[ref];
      if (!qo) return;
      if (!qOutcomesByQuestion[qo.questionId]) qOutcomesByQuestion[qo.questionId] = [];
      qOutcomesByQuestion[qo.questionId].push({
        score: qo.score ?? 0,
        automark: qo.automark ?? 0,
        markerModifier: qo.markerModifier ?? 0,
        maxScore: qo.maxScore ?? questionMap[qo.questionId]?.points ?? 1,
        studentIdx: si,
      });
    });
  });

  return {
    students, questions, qOutcomesByQuestion, groupings,
    maxScore, examWritingTime,
    accessCodes: raw.accessCodes,
    assessmentSettings: raw.assessmentSettings[0] || {},
  };
}

// Auto-detect meaningful grouping dimensions from student data
function detectGroupings(students) {
  const dims = [];

  // 1. Access codes
  const codeCounts = {};
  students.forEach(s => { const g = s.accessCode || null; codeCounts[g || '(none)'] = (codeCounts[g || '(none)'] || 0) + 1; });
  const codeGroups = Object.keys(codeCounts).filter(k => k !== '(none)');
  if (codeGroups.length >= 2) {
    dims.push({
      id: 'accessCode', label: `Access Code (${codeGroups.length} groups)`,
      groupFn: s => s.accessCode || '(no code)',
    });
  }

  // 2. Deferred status
  const deferredCount = students.filter(s => s.deferred).length;
  if (deferredCount > 0 && deferredCount < students.length) {
    dims.push({
      id: 'deferred', label: `Exam Sitting (${deferredCount} deferred)`,
      groupFn: s => s.deferred ? 'Deferred' : 'Standard',
    });
  }

  // 3. Enrollment tags — split each unique tag into a group
  const allTags = new Set();
  students.forEach(s => s.enrollmentTags.forEach(t => allTags.add(t)));
  if (allTags.size >= 2) {
    dims.push({
      id: 'enrollmentTag', label: `Enrollment Tags (${allTags.size} tags)`,
      groupFn: s => s.enrollmentTags.length ? s.enrollmentTags.join(', ') : '(untagged)',
    });
  }

  // 4. Force-submitted vs normal
  const forceCount = students.filter(s => s.forceSubmitted).length;
  if (forceCount > 0 && forceCount < students.length) {
    dims.push({
      id: 'forceSubmitted', label: `Submission Type (${forceCount} forced)`,
      groupFn: s => s.forceSubmitted ? 'Force-submitted' : 'Self-submitted',
    });
  }

  // 5. Score quartile (always available as a fallback)
  dims.push({
    id: 'quartile', label: 'Score Quartile',
    groupFn: s => {
      const p = s.maxScore > 0 ? (s.score / s.maxScore) * 100 : 0;
      if (p >= 75) return 'Q4 (75-100%)';
      if (p >= 50) return 'Q3 (50-75%)';
      if (p >= 25) return 'Q2 (25-50%)';
      return 'Q1 (0-25%)';
    },
  });

  return dims;
}

// ── Analysis Reports: Shared Helpers ────────────────────────────────────────

function analysisStats(vals) {
  if (!vals.length) return { n: 0, mean: 0, median: 0, sd: 0, min: 0, max: 0 };
  const r2 = v => parseFloat(v.toFixed(2));
  const sorted = [...vals].sort((a, b) => a - b);
  const n = vals.length;
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    n, mean: r2(mean), median: r2(sorted[Math.floor(n / 2)]),
    sd: r2(Math.sqrt(variance)), min: r2(sorted[0]), max: r2(sorted[n - 1]),
  };
}

function makeTable(headers, rows, options = {}) {
  const table = document.createElement('table');
  table.className = 'analysis-table';
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = typeof h === 'object' ? h.label : h;
    if ((typeof h === 'object' && h.num) || false) th.className = 'num';
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach((cell, ci) => {
      const td = document.createElement('td');
      if (typeof cell === 'object' && cell.html) { td.innerHTML = cell.html; }
      else { td.textContent = cell ?? ''; }
      if (typeof headers[ci] === 'object' && headers[ci].num) td.className = 'num';
      if (typeof cell === 'object' && cell.cls) td.className += ' ' + cell.cls;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function makeTitle(text) {
  const el = document.createElement('div');
  el.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:6px;color:#1a1a2e;';
  el.textContent = text;
  return el;
}

function makeSubtext(text) {
  const el = document.createElement('div');
  el.style.cssText = 'font-size:12px;color:#666;margin-bottom:10px;';
  el.textContent = text;
  return el;
}

function pct(val, max) { return max > 0 ? parseFloat(((val / max) * 100).toFixed(1)) : 0; }

function drawGroupedBarChart(groups, series, options = {}) {
  // groups: [{label}], series: [{name, color, values:[number]}]
  const nGroups = groups.length;
  const nSeries = series.length;
  const groupW = Math.max(60, Math.min(100, Math.floor(650 / nGroups)));
  const barW = Math.max(12, Math.floor((groupW - 10) / nSeries));

  const canvas = document.createElement('canvas');
  canvas.width = nGroups * groupW + 60;
  canvas.height = options.height || 240;
  const ctx = canvas.getContext('2d');
  const [padL, padT] = [40, 20];
  const chartH = canvas.height - padT - 44;
  const chartW = canvas.width - padL - 10;

  const maxVal = Math.max(...series.flatMap(s => s.values), 1);

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grid
  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH - (i / 4) * chartH;
    ctx.strokeStyle = '#dde'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * maxVal), padL - 4, y + 3);
  }

  groups.forEach((g, gi) => {
    const gx = padL + gi * groupW;
    series.forEach((s, si) => {
      const val = s.values[gi] || 0;
      const bh = (val / maxVal) * chartH;
      const x = gx + 4 + si * barW;
      const y = padT + chartH - bh;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y, barW - 2, bh);
      if (val > 0) {
        ctx.fillStyle = '#333'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(val, x + (barW - 2) / 2, y - 2);
      }
    });
    // Group label
    ctx.fillStyle = '#333'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const labelX = gx + groupW / 2;
    ctx.fillText(g.label, labelX, padT + chartH + 14);
    if (g.sub) {
      ctx.fillStyle = '#888'; ctx.font = '9px sans-serif';
      ctx.fillText(g.sub, labelX, padT + chartH + 26);
    }
  });

  // Axes
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + chartH + 1); ctx.lineTo(padL + chartW, padT + chartH + 1); ctx.stroke();
  if (options.yLabel) {
    ctx.save(); ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.translate(10, padT + chartH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(options.yLabel, 0, 0); ctx.restore();
  }

  return canvas;
}

function makeChartLegend(items) {
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;';
  items.forEach(({ color, label }) => {
    const span = document.createElement('span');
    span.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${color};vertical-align:-1px;margin-right:4px"></span>${label}`;
    legend.appendChild(span);
  });
  return legend;
}

// ── Load groups button ───────────────────────────────────────────────────────

document.getElementById('btn-load-groups')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-load-groups');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const data = await loadAnalysisData();
    if (!data) { log('Apollo cache not found — is the Cadmus page fully loaded?', 'err'); return; }
    const model = buildAnalysisModel(data);
    window._analysisModel = model;
    const groupSel = document.getElementById('analysis-grouping');
    if (groupSel) {
      groupSel.innerHTML = '<option value="">Full cohort (no grouping)</option>';
      if (model.groupings.length) {
        model.groupings.forEach(g => {
          const opt = document.createElement('option');
          opt.value = g.id; opt.textContent = g.label;
          groupSel.appendChild(opt);
        });
        log(`Detected ${model.groupings.length} grouping dimension(s): ${model.groupings.map(g => g.label).join(', ')}`, 'ok');
      } else {
        log('No grouping dimensions detected in this assessment.', 'err');
      }
      groupSel.value = '';
    }
  } catch (err) {
    log(`Failed to load groups: ${err.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Load groups';
  }
});

// ── Grouping helpers for sub-reports ─────────────────────────────────────────

function getActiveGrouping(model) {
  const dimId = document.getElementById('analysis-grouping')?.value;
  if (!dimId) return null;
  return model.groupings.find(g => g.id === dimId) || null;
}

// Given a map of { catKey → { outcomes: [{pct, studentIdx}] } }, returns
// { catKey → { groupName → meanPct } } and sorted group names.
function computeGroupMeans(categoryMap, model, dim) {
  const catGroupMeans = {};
  const allGroupNames = new Set();
  for (const [cat, data] of Object.entries(categoryMap)) {
    const byGroup = {};
    data.outcomes.forEach(o => {
      const s = model.students[o.studentIdx];
      if (!s) return;
      const g = dim.groupFn(s);
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(o.pct);
      allGroupNames.add(g);
    });
    catGroupMeans[cat] = {};
    for (const [g, pcts] of Object.entries(byGroup)) {
      catGroupMeans[cat][g] = analysisStats(pcts).mean;
    }
  }
  const catchAll = /^\(|^unknown/i;
  const groupNames = [...allGroupNames].sort((a, b) => {
    if (catchAll.test(a) && !catchAll.test(b)) return 1;
    if (!catchAll.test(a) && catchAll.test(b)) return -1;
    return a.localeCompare(b);
  });
  return { catGroupMeans, groupNames };
}

const GROUP_COLORS = ['#1565c0', '#2e7d32', '#f9a825', '#ef6c00', '#c62828', '#7b1fa2', '#00838f', '#4e342e'];

// ── Analysis Report 1: Tute Group Comparison ────────────────────────────────

function renderGroupComparisonReport(container, model) {
  // Get selected grouping dimension (empty string = "Full cohort")
  const groupSel = document.getElementById('analysis-grouping');
  const dimId = groupSel?.value || '';
  const dim = model.groupings.find(g => g.id === dimId) || null;

  if (!dim) {
    // Full-cohort view: grade band breakdown for entire class
    const cohortPcts = model.students.map(s => pct(s.score, s.maxScore));
    const cohortStats = analysisStats(cohortPcts);
    container.appendChild(makeTitle(`Full Cohort Overview — ${model.students.length} students`));
    container.appendChild(makeSubtext(`Mean: ${cohortStats.mean}% | Median: ${cohortStats.median}% | SD: ${cohortStats.sd}% | Min: ${cohortStats.min}% | Max: ${cohortStats.max}%`));
    if (model.groupings.length) {
      container.appendChild(makeSubtext(`Select a grouping dimension above to compare groups. Available: ${model.groupings.map(g => g.label).join(', ')}`));
    } else {
      container.appendChild(makeSubtext('No grouping dimensions detected. Load data from a page with tutorial groups or access codes to enable group comparison.'));
    }
    // Grade band bar chart for full cohort
    const bandCounts = GRADE_BANDS.map(b => ({ ...b, count: 0 }));
    cohortPcts.forEach(p => {
      for (let i = GRADE_BANDS.length - 1; i >= 0; i--) {
        if (p >= GRADE_BANDS[i].min) { bandCounts[i].count++; break; }
      }
    });
    const n = model.students.length;
    const series = [{ name: 'Students', color: '#1565c0', values: bandCounts.map(b => b.count) }];
    const groups = bandCounts.map(b => ({ label: b.label, sub: `${b.min}%+` }));
    const canvas = drawGroupedBarChart(groups, series, { yLabel: '# Students', height: 200 });
    // Annotate bars with count + %
    const ctx = canvas.getContext('2d');
    const barW = canvas.width / bandCounts.length;
    const peakH = 200 - 44 - 20;
    const peak = Math.max(...bandCounts.map(b => b.count), 1);
    bandCounts.forEach((b, i) => {
      if (!b.count) return;
      const barH = (b.count / peak) * peakH;
      const x = 40 + i * (canvas.width - 50) / bandCounts.length + (canvas.width - 50) / bandCounts.length / 2;
      const y = 20 + peakH - barH - 4;
      ctx.fillStyle = '#333'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`${b.count} (${Math.round(b.count / n * 100)}%)`, x, y);
    });
    container.appendChild(canvas);
    addCopyButton(container, canvas);
    return;
  }

  // Group students by the selected dimension
  const groups = {};
  model.students.forEach(s => {
    const g = dim.groupFn(s);
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  const cohortStats = analysisStats(model.students.map(s => pct(s.score, s.maxScore)));
  const groupNames = Object.keys(groups).sort((a, b) => {
    // Push catch-all labels to end
    const catchAll = /^\(|^unknown/i;
    if (catchAll.test(a) && !catchAll.test(b)) return 1;
    if (!catchAll.test(a) && catchAll.test(b)) return -1;
    return a.localeCompare(b);
  });

  container.appendChild(makeTitle(`Group Comparison: ${dim.label} — ${model.students.length} students`));
  container.appendChild(makeSubtext(`Cohort mean: ${cohortStats.mean}% | Median: ${cohortStats.median}% | SD: ${cohortStats.sd}%`));

  // Summary table
  const tableRows = groupNames.map(name => {
    const pcts = groups[name].map(s => pct(s.score, s.maxScore));
    const gs = analysisStats(pcts);
    const dev = Math.abs(gs.mean - cohortStats.mean);
    const flag = dev > cohortStats.sd;
    return [
      name,
      { html: `${gs.n}`, cls: 'num' },
      { html: `${gs.mean}%${flag ? ' <span class="analysis-flag">*</span>' : ''}`, cls: 'num' },
      { html: `${gs.median}%`, cls: 'num' },
      { html: `${gs.sd}%`, cls: 'num' },
      { html: `${gs.min}%`, cls: 'num' },
      { html: `${gs.max}%`, cls: 'num' },
    ];
  });
  container.appendChild(makeTable(
    ['Group', { label: 'n', num: true }, { label: 'Mean', num: true }, { label: 'Median', num: true },
     { label: 'SD', num: true }, { label: 'Min', num: true }, { label: 'Max', num: true }],
    tableRows
  ));

  const note = document.createElement('div');
  note.style.cssText = 'font-size:10px;color:#999;margin-bottom:10px;';
  note.textContent = '* Mean deviates more than 1 SD from cohort mean';
  container.appendChild(note);

  // Grade band chart per group
  const colors = ['#1565c0', '#2e7d32', '#f9a825', '#ef6c00', '#c62828', '#7b1fa2', '#00838f', '#4e342e'];
  const seriesData = groupNames.map(name => {
    const bandCounts = GRADE_BANDS.map(() => 0);
    groups[name].forEach(s => {
      const band = gradeFor(s.score, s.maxScore);
      const idx = GRADE_BANDS.findIndex(b => b.label === band.label);
      if (idx >= 0) bandCounts[idx]++;
    });
    return bandCounts;
  });

  const series = groupNames.map((name, i) => ({
    name: `${name} (n=${groups[name].length})`,
    color: colors[i % colors.length],
    values: GRADE_BANDS.map((_, bi) => seriesData[i][bi]),
  }));

  const bandGroups = GRADE_BANDS.map(b => ({ label: b.label, sub: `${b.min}%+` }));
  const canvas = drawGroupedBarChart(bandGroups, series, { yLabel: '# Students' });
  container.appendChild(canvas);
  container.appendChild(makeChartLegend(series.map(s => ({ color: s.color, label: s.name }))));
  addCopyButton(container, canvas);
}

// ── Analysis Report 3: Cognitive Complexity ──────────────────────────────────

function renderBloomsReport(container, model) {
  const bloomLevels = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
  const bloomData = {};
  const usedQuestions = model.questions.filter(q => (model.qOutcomesByQuestion[q.id] || []).length > 0);

  usedQuestions.forEach(q => {
    if (!q.bloom) return;
    const level = bloomLevels.find(l => q.bloom.startsWith(l)) || q.bloom;
    if (!bloomData[level]) bloomData[level] = { questions: [], totalPoints: 0, outcomes: [] };
    bloomData[level].questions.push(q);
    bloomData[level].totalPoints += q.points;
    const outcomes = model.qOutcomesByQuestion[q.id] || [];
    outcomes.forEach(o => bloomData[level].outcomes.push({ pct: pct(o.score, o.maxScore), studentIdx: o.studentIdx }));
  });

  const levels = bloomLevels.filter(l => bloomData[l]);
  const untagged = usedQuestions.filter(q => !q.bloom);
  const dim = getActiveGrouping(model);
  const { catGroupMeans, groupNames } = dim ? computeGroupMeans(bloomData, model, dim) : { catGroupMeans: {}, groupNames: [] };

  container.appendChild(makeTitle(`Cognitive Complexity — ${usedQuestions.length} questions${dim ? ` by ${dim.label}` : ''}`));
  if (untagged.length) container.appendChild(makeSubtext(`${untagged.length} questions without cognitive complexity tags excluded`));

  const headers = ['Cognitive Level', { label: 'Questions', num: true }, { label: 'Points', num: true },
    { label: 'Responses', num: true }, { label: 'Mean %', num: true }, { label: 'Median %', num: true }, { label: 'SD', num: true },
    ...groupNames.map(g => ({ label: g, num: true }))];

  const tableRows = levels.map(level => {
    const d = bloomData[level];
    const stats = analysisStats(d.outcomes.map(o => o.pct));
    const meanPct = stats.mean;
    const bg = meanPct >= 70 ? '#c8e6c9' : meanPct >= 50 ? '#fff9c4' : '#ffcdd2';
    const groupCells = groupNames.map(g => {
      const m = catGroupMeans[level]?.[g] ?? null;
      return { html: m !== null ? `${m}%` : '—', cls: 'num' };
    });
    return [
      level.charAt(0).toUpperCase() + level.slice(1),
      { html: `${d.questions.length}`, cls: 'num' },
      { html: `${d.totalPoints}`, cls: 'num' },
      { html: `${d.outcomes.length}`, cls: 'num' },
      { html: `<span style="background:${bg};padding:2px 6px;border-radius:3px;font-weight:600">${meanPct}%</span>`, cls: 'num' },
      { html: `${stats.median}%`, cls: 'num' },
      { html: `${stats.sd}%`, cls: 'num' },
      ...groupCells,
    ];
  });
  container.appendChild(makeTable(headers, tableRows));

  const chartGroups = levels.map(l => ({ label: l.charAt(0).toUpperCase() + l.slice(1) }));
  const series = dim && groupNames.length
    ? groupNames.map((g, i) => ({
        name: g, color: GROUP_COLORS[i % GROUP_COLORS.length],
        values: levels.map(l => catGroupMeans[l]?.[g] ?? 0),
      }))
    : [{ name: 'Mean % Correct', color: '#1976d2', values: levels.map(l => analysisStats(bloomData[l].outcomes.map(o => o.pct)).mean) }];

  const canvas = drawGroupedBarChart(chartGroups, series, { yLabel: 'Mean % Correct', height: 220 });
  container.appendChild(canvas);
  if (dim && groupNames.length) container.appendChild(makeChartLegend(series.map(s => ({ color: s.color, label: s.name }))));
  addCopyButton(container, canvas);
}

// ── Analysis Report 4: Topic / Week Performance ─────────────────────────────

function renderTopicReport(container, model) {
  const weekData = {};
  const usedQuestions = model.questions.filter(q => (model.qOutcomesByQuestion[q.id] || []).length > 0);

  usedQuestions.forEach(q => {
    const label = q.week || '(untagged)';
    if (!weekData[label]) weekData[label] = { questions: [], totalPoints: 0, outcomes: [] };
    weekData[label].questions.push(q);
    weekData[label].totalPoints += q.points;
    const outcomes = model.qOutcomesByQuestion[q.id] || [];
    outcomes.forEach(o => weekData[label].outcomes.push({ pct: pct(o.score, o.maxScore), studentIdx: o.studentIdx }));
  });

  const weeks = Object.keys(weekData).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, '')) || 999;
    const nb = parseInt(b.replace(/\D/g, '')) || 999;
    return na - nb;
  });

  const dim = getActiveGrouping(model);
  const { catGroupMeans, groupNames } = dim ? computeGroupMeans(weekData, model, dim) : { catGroupMeans: {}, groupNames: [] };

  container.appendChild(makeTitle(`Topic / Week Performance — ${usedQuestions.length} questions, ${weeks.length} topics${dim ? ` by ${dim.label}` : ''}`));

  const headers = ['Week / Topic', { label: 'Questions', num: true }, { label: 'Points', num: true },
    'Types', { label: 'Mean %', num: true }, { label: 'Median %', num: true }, { label: 'SD', num: true },
    ...groupNames.map(g => ({ label: g, num: true }))];

  const tableRows = weeks.map(w => {
    const d = weekData[w];
    const stats = analysisStats(d.outcomes.map(o => o.pct));
    const types = [...new Set(d.questions.map(q => q.type))].join(', ');
    const groupCells = groupNames.map(g => ({
      html: catGroupMeans[w]?.[g] != null ? `${catGroupMeans[w][g]}%` : '—', cls: 'num',
    }));
    return [
      w,
      { html: `${d.questions.length}`, cls: 'num' },
      { html: `${d.totalPoints}`, cls: 'num' },
      types,
      { html: `${stats.mean}%`, cls: 'num' },
      { html: `${stats.median}%`, cls: 'num' },
      { html: `${stats.sd}%`, cls: 'num' },
      ...groupCells,
    ];
  });
  container.appendChild(makeTable(headers, tableRows));

  const chartGroups = weeks.map(w => ({ label: w }));
  const series = dim && groupNames.length
    ? groupNames.map((g, i) => ({
        name: g, color: GROUP_COLORS[i % GROUP_COLORS.length],
        values: weeks.map(w => catGroupMeans[w]?.[g] ?? 0),
      }))
    : [{ name: 'Mean % Correct', color: '#1976d2', values: weeks.map(w => analysisStats(weekData[w].outcomes.map(o => o.pct)).mean) }];

  const canvas = drawGroupedBarChart(chartGroups, series, { yLabel: 'Mean % Correct', height: 200 });
  container.appendChild(canvas);
  if (dim && groupNames.length) container.appendChild(makeChartLegend(series.map(s => ({ color: s.color, label: s.name }))));
  addCopyButton(container, canvas);
}

// ── Analysis Report 5: Difficulty Analysis ──────────────────────────────────

function renderDifficultyReport(container, model) {
  const diffLevels = ['EASY', 'MEDIUM', 'HARD'];
  const diffData = {};
  const usedQuestions = model.questions.filter(q => (model.qOutcomesByQuestion[q.id] || []).length > 0);

  usedQuestions.forEach(q => {
    const d = q.difficulty || '(untagged)';
    if (!diffData[d]) diffData[d] = { questions: [], outcomes: [] };
    diffData[d].questions.push(q);
    const outcomes = model.qOutcomesByQuestion[q.id] || [];
    outcomes.forEach(o => diffData[d].outcomes.push({ pct: pct(o.score, o.maxScore), studentIdx: o.studentIdx, qType: q.type }));
  });

  const levels = [...diffLevels.filter(l => diffData[l]), ...Object.keys(diffData).filter(l => !diffLevels.includes(l))];
  const dim = getActiveGrouping(model);
  const { catGroupMeans, groupNames } = dim ? computeGroupMeans(diffData, model, dim) : { catGroupMeans: {}, groupNames: [] };

  container.appendChild(makeTitle(`Difficulty Analysis — ${usedQuestions.length} questions${dim ? ` by ${dim.label}` : ''}`));

  const headers = ['Tagged Difficulty', { label: 'Questions', num: true }, { label: 'Responses', num: true },
    { label: 'Mean %', num: true }, { label: 'Median %', num: true }, { label: 'SD', num: true }, 'Validation',
    ...groupNames.map(g => ({ label: g, num: true }))];

  const tableRows = levels.map(level => {
    const d = diffData[level];
    const stats = analysisStats(d.outcomes.map(o => o.pct));
    let mismatch = '';
    if (level === 'EASY' && stats.mean < 60) mismatch = 'Tagged EASY but mean <60%';
    else if (level === 'HARD' && stats.mean > 80) mismatch = 'Tagged HARD but mean >80%';
    else if (level === 'MEDIUM' && (stats.mean < 40 || stats.mean > 90)) mismatch = 'Unexpected range for MEDIUM';
    const groupCells = groupNames.map(g => ({
      html: catGroupMeans[level]?.[g] != null ? `${catGroupMeans[level][g]}%` : '—', cls: 'num',
    }));
    return [
      level,
      { html: `${d.questions.length}`, cls: 'num' },
      { html: `${d.outcomes.length}`, cls: 'num' },
      { html: `${stats.mean}%`, cls: 'num' },
      { html: `${stats.median}%`, cls: 'num' },
      { html: `${stats.sd}%`, cls: 'num' },
      mismatch ? { html: `<span class="analysis-flag">${mismatch}</span>` } : { html: '<span class="analysis-ok">OK</span>' },
      ...groupCells,
    ];
  });
  container.appendChild(makeTable(headers, tableRows));

  const chartGroups = levels.map(l => ({ label: l }));
  const series = dim && groupNames.length
    ? groupNames.map((g, i) => ({
        name: g, color: GROUP_COLORS[i % GROUP_COLORS.length],
        values: levels.map(l => catGroupMeans[l]?.[g] ?? 0),
      }))
    : [{ name: 'Mean % Correct', color: '#1976d2', values: levels.map(l => analysisStats(diffData[l].outcomes.map(o => o.pct)).mean) }];

  const canvas = drawGroupedBarChart(chartGroups, series, { yLabel: 'Mean % Correct', height: 200 });
  container.appendChild(canvas);
  if (dim && groupNames.length) container.appendChild(makeChartLegend(series.map(s => ({ color: s.color, label: s.name }))));

  // Expected difficulty threshold lines (only meaningful on the overall single-series view)
  if (!dim) {
    const ctx = canvas.getContext('2d');
    const padL = 40, padT = 20, chartH = canvas.height - padT - 44;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 1;
    [80, 60, 40].forEach((threshold, i) => {
      if (i < levels.length) {
        const y = padT + chartH - (threshold / 100) * chartH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(canvas.width - 10, y); ctx.stroke();
        ctx.fillStyle = '#d32f2f'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(`${threshold}%`, canvas.width - 12, y - 2);
      }
    });
    ctx.setLineDash([]);
  }

  addCopyButton(container, canvas);
}

// ── Analysis Report 6: Question Type Breakdown ──────────────────────────────

function renderQuestionTypeReport(container, model) {
  const typeData = {};
  const usedQuestions = model.questions.filter(q => (model.qOutcomesByQuestion[q.id] || []).length > 0);

  usedQuestions.forEach(q => {
    const t = q.type || 'UNKNOWN';
    if (!typeData[t]) typeData[t] = { questions: [], totalPoints: 0, outcomes: [] };
    typeData[t].questions.push(q);
    typeData[t].totalPoints += q.points;
    const outcomes = model.qOutcomesByQuestion[q.id] || [];
    outcomes.forEach(o => typeData[t].outcomes.push({
      pct: pct(o.score, o.maxScore), studentIdx: o.studentIdx,
      automark: o.automark, markerMod: o.markerModifier,
    }));
  });

  const types = Object.keys(typeData).sort();
  const totalPoints = types.reduce((s, t) => s + typeData[t].totalPoints, 0);
  const dim = getActiveGrouping(model);
  const { catGroupMeans, groupNames } = dim ? computeGroupMeans(typeData, model, dim) : { catGroupMeans: {}, groupNames: [] };

  container.appendChild(makeTitle(`Question Type Breakdown — ${usedQuestions.length} questions${dim ? ` by ${dim.label}` : ''}`));

  const headers = ['Type', { label: 'Questions', num: true }, { label: 'Total Pts', num: true },
    { label: 'Weight', num: true }, { label: 'Mean %', num: true }, { label: 'Median %', num: true }, { label: 'SD', num: true },
    ...groupNames.map(g => ({ label: g, num: true }))];

  const tableRows = types.map(type => {
    const d = typeData[type];
    const stats = analysisStats(d.outcomes.map(o => o.pct));
    const weight = totalPoints > 0 ? parseFloat(((d.totalPoints / totalPoints) * 100).toFixed(1)) : 0;
    const groupCells = groupNames.map(g => ({
      html: catGroupMeans[type]?.[g] != null ? `${catGroupMeans[type][g]}%` : '—', cls: 'num',
    }));
    return [
      type,
      { html: `${d.questions.length}`, cls: 'num' },
      { html: `${d.totalPoints}`, cls: 'num' },
      { html: `${weight}%`, cls: 'num' },
      { html: `${stats.mean}%`, cls: 'num' },
      { html: `${stats.median}%`, cls: 'num' },
      { html: `${stats.sd}%`, cls: 'num' },
      ...groupCells,
    ];
  });
  container.appendChild(makeTable(headers, tableRows));

  const chartGroups = types.map(t => ({ label: t, sub: `${typeData[t].questions.length}q / ${typeData[t].totalPoints}pts` }));
  const series = dim && groupNames.length
    ? groupNames.map((g, i) => ({
        name: g, color: GROUP_COLORS[i % GROUP_COLORS.length],
        values: types.map(t => catGroupMeans[t]?.[g] ?? 0),
      }))
    : [{ name: 'Mean % Correct', color: '#1976d2', values: types.map(t => analysisStats(typeData[t].outcomes.map(o => o.pct)).mean) }];

  const canvas = drawGroupedBarChart(chartGroups, series, { yLabel: 'Mean % Correct', height: 200 });
  container.appendChild(canvas);
  if (dim && groupNames.length) container.appendChild(makeChartLegend(series.map(s => ({ color: s.color, label: s.name }))));
  addCopyButton(container, canvas);
}

// ── Analysis Report 7: Exam Timing ──────────────────────────────────────────

function renderTimingReport(container, model) {
  const timings = [];
  model.students.forEach(s => {
    if (!s.startDate || !s.submittedAt) return;
    const durationMin = (s.submittedAt - s.startDate) / 60000;
    if (durationMin > 0 && durationMin < 600) { // sanity cap at 10h
      timings.push({
        name: s.name, duration: parseFloat(durationMin.toFixed(1)),
        forceSubmitted: s.forceSubmitted, deferred: s.deferred,
        score: s.score, maxScore: s.maxScore,
      });
    }
  });

  container.appendChild(makeTitle(`Exam Timing Profile — ${timings.length} submissions`));

  if (!timings.length) {
    container.appendChild(makeSubtext('No timing data available (startDate/submittedAt not found).'));
    return;
  }

  const durations = timings.map(t => t.duration);
  const stats = analysisStats(durations);
  const forceCount = timings.filter(t => t.forceSubmitted).length;
  const fastCount = timings.filter(t => t.duration < model.examWritingTime * 0.5).length;

  container.appendChild(makeSubtext(
    `Writing time: ${model.examWritingTime} min | Mean duration: ${stats.mean} min | Median: ${stats.median} min | ` +
    `Force-submitted: ${forceCount} | <50% time used: ${fastCount}`
  ));

  // Histogram: bucket by 5-min intervals
  const bucketSize = 5;
  const maxDur = Math.ceil(stats.max / bucketSize) * bucketSize;
  const buckets = {};
  for (let i = 0; i <= maxDur; i += bucketSize) buckets[i] = { all: 0, forced: 0 };
  timings.forEach(t => {
    const bin = Math.floor(t.duration / bucketSize) * bucketSize;
    const key = Math.min(bin, maxDur);
    buckets[key].all++;
    if (t.forceSubmitted) buckets[key].forced++;
  });

  const labels = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...labels.map(k => buckets[k].all), 1);

  const canvas = document.createElement('canvas');
  const slotW = Math.max(24, Math.min(40, Math.floor(600 / labels.length)));
  canvas.width = labels.length * slotW + 60;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const [padL, padB, padT] = [40, 44, 20];
  const chartW = canvas.width - padL - 10;
  const chartH = canvas.height - padB - padT;

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH - (i / 4) * chartH;
    ctx.strokeStyle = '#dde'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * maxCount), padL - 4, y + 3);
  }

  // Writing time reference line
  const wtBin = labels.findIndex(l => l >= model.examWritingTime);
  if (wtBin >= 0) {
    const x = padL + wtBin * slotW;
    ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + chartH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#d32f2f'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${model.examWritingTime}m limit`, x + 3, padT + 10);
  }

  labels.forEach((label, i) => {
    const x = padL + i * slotW;
    const b = buckets[label];
    const regCount = b.all - b.forced;

    // Regular (blue)
    if (regCount > 0) {
      const bh = (regCount / maxCount) * chartH;
      ctx.fillStyle = '#1976d2';
      ctx.fillRect(x + 2, padT + chartH - bh, slotW - 4, bh);
    }
    // Forced (orange stacked on top)
    if (b.forced > 0) {
      const regH = (regCount / maxCount) * chartH;
      const forceH = (b.forced / maxCount) * chartH;
      ctx.fillStyle = '#ef6c00';
      ctx.fillRect(x + 2, padT + chartH - regH - forceH, slotW - 4, forceH);
    }
    // Count label
    if (b.all > 0) {
      const totalH = (b.all / maxCount) * chartH;
      ctx.fillStyle = '#333'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(b.all, x + slotW / 2, padT + chartH - totalH - 2);
    }

    ctx.fillStyle = '#555'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${label}`, x + slotW / 2, padT + chartH + 13);
  });

  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + chartH + 1); ctx.lineTo(padL + chartW, padT + chartH + 1); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Duration (minutes)', padL + chartW / 2, canvas.height - 2);
  ctx.save(); ctx.translate(10, padT + chartH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('# Students', 0, 0); ctx.restore();

  container.appendChild(canvas);
  container.appendChild(makeChartLegend([
    { color: '#1976d2', label: 'Submitted' },
    { color: '#ef6c00', label: 'Force-submitted' },
    { color: '#d32f2f', label: 'Writing time limit' },
  ]));
  addCopyButton(container, canvas);

  // Flag table: unusual timings
  const flags = [];
  timings.filter(t => t.forceSubmitted).forEach(t => flags.push([t.name, `${t.duration} min`, 'Force-submitted', `${pct(t.score, t.maxScore)}%`]));
  timings.filter(t => !t.forceSubmitted && t.duration < model.examWritingTime * 0.5).forEach(t => flags.push([t.name, `${t.duration} min`, '<50% time used', `${pct(t.score, t.maxScore)}%`]));

  if (flags.length) {
    const flagTitle = document.createElement('div');
    flagTitle.style.cssText = 'font-size:13px;font-weight:600;margin-top:12px;color:#d32f2f;';
    flagTitle.textContent = `Flagged Submissions (${flags.length})`;
    container.appendChild(flagTitle);
    container.appendChild(makeTable(['Student', 'Duration', 'Flag', 'Score %'], flags));
  }
}

// ── Analysis Report 8: Automark Analysis ────────────────────────────────────

function renderAutomarkReport(container, model) {
  const adjVals = model.students.map(s => s.markerModifier);
  const modVals = model.students.map(s => s.moderatorModifier);
  const adjStats = analysisStats(adjVals);
  const hasModeration = modVals.some(v => v !== 0);

  container.appendChild(makeTitle(`Automark vs Human Adjustment — ${model.students.length} students`));
  container.appendChild(makeSubtext(
    `Marker adjustment: mean ${adjStats.mean}, range [${adjStats.min}, ${adjStats.max}]` +
    (hasModeration ? ` | Moderator adjustments also present` : '')
  ));

  // Per question-type breakdown of adjustments
  const typeAdj = {};
  model.questions.forEach(q => {
    const t = q.type || 'UNKNOWN';
    if (!typeAdj[t]) typeAdj[t] = { automarks: [], markerMods: [], totalPts: 0 };
    typeAdj[t].totalPts += q.points;
    const outcomes = model.qOutcomesByQuestion[q.id] || [];
    outcomes.forEach(o => {
      typeAdj[t].automarks.push(o.automark);
      typeAdj[t].markerMods.push(o.markerModifier);
    });
  });

  const types = Object.keys(typeAdj).sort();
  const tableRows = types.map(type => {
    const d = typeAdj[type];
    const autoStats = analysisStats(d.automarks);
    const modStats = analysisStats(d.markerMods);
    const direction = modStats.mean > 0.05 ? 'Markers add' : modStats.mean < -0.05 ? 'Markers reduce' : 'Neutral';
    const dirCls = modStats.mean > 0.05 ? 'analysis-ok' : modStats.mean < -0.05 ? 'analysis-flag' : '';
    return [
      type,
      { html: `${d.automarks.length}`, cls: 'num' },
      { html: `${autoStats.mean}`, cls: 'num' },
      { html: `${modStats.mean}`, cls: 'num' },
      { html: `${modStats.sd}`, cls: 'num' },
      { html: `[${modStats.min}, ${modStats.max}]`, cls: 'num' },
      { html: `<span class="${dirCls}">${direction}</span>` },
    ];
  });

  container.appendChild(makeTable(
    ['Type', { label: 'Responses', num: true }, { label: 'Automark Mean', num: true },
     { label: 'Adj Mean', num: true }, { label: 'Adj SD', num: true },
     { label: 'Adj Range', num: true }, 'Direction'],
    tableRows
  ));

  // Student-level adjustment distribution histogram
  const adjBucketSize = 0.5;
  const minAdj = Math.floor(adjStats.min / adjBucketSize) * adjBucketSize;
  const maxAdj = Math.ceil(adjStats.max / adjBucketSize) * adjBucketSize;
  const buckets = {};
  for (let v = minAdj; v <= maxAdj; v = parseFloat((v + adjBucketSize).toFixed(1))) buckets[v] = 0;
  model.students.forEach(s => {
    const bin = parseFloat((Math.round(s.markerModifier / adjBucketSize) * adjBucketSize).toFixed(1));
    const key = Math.max(minAdj, Math.min(maxAdj, bin));
    buckets[key] = (buckets[key] || 0) + 1;
  });

  const labels = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const maxCount = Math.max(...labels.map(k => buckets[k]), 1);

  const canvas = document.createElement('canvas');
  const slotW = Math.max(20, Math.min(36, Math.floor(600 / labels.length)));
  canvas.width = labels.length * slotW + 60;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');
  const [padL, padB, padT] = [40, 36, 20];
  const chartW = canvas.width - padL - 10;
  const chartH = canvas.height - padB - padT;

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH - (i / 4) * chartH;
    ctx.strokeStyle = '#dde'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * maxCount), padL - 4, y + 3);
  }

  // Zero line
  const zeroIdx = labels.indexOf(0);
  if (zeroIdx >= 0) {
    const x = padL + zeroIdx * slotW + slotW / 2;
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + chartH); ctx.stroke();
    ctx.setLineDash([]);
  }

  labels.forEach((label, i) => {
    const x = padL + i * slotW;
    const count = buckets[label];
    if (count > 0) {
      const bh = (count / maxCount) * chartH;
      ctx.fillStyle = label < 0 ? '#ef6c00' : label > 0 ? '#1976d2' : '#78909c';
      ctx.fillRect(x + 2, padT + chartH - bh, slotW - 4, bh);
      ctx.fillStyle = '#333'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(count, x + slotW / 2, padT + chartH - bh - 2);
    }
    if (label === 0 || label === minAdj || label === maxAdj || label % 2 === 0) {
      ctx.fillStyle = '#555'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, x + slotW / 2, padT + chartH + 13);
    }
  });

  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + chartH + 1); ctx.lineTo(padL + chartW, padT + chartH + 1); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Marker Adjustment (points)', padL + chartW / 2, canvas.height - 2);
  ctx.save(); ctx.translate(10, padT + chartH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('# Students', 0, 0); ctx.restore();

  container.appendChild(canvas);
  container.appendChild(makeChartLegend([
    { color: '#ef6c00', label: 'Negative adj' },
    { color: '#78909c', label: 'No change' },
    { color: '#1976d2', label: 'Positive adj' },
  ]));
  addCopyButton(container, canvas);
}

// ── Init ─────────────────────────────────────────────────────────────────────
checkContext();
checkForUpdate();
