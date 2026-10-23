import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const writesByFile = new Map();
const UNCLASSIFIED_MASK = '[redacted answer: classification unavailable]';
const CONTENT_TYPES = new Set(['text', 'image', 'inputText', 'inputImage', 'inputAudio', 'url', 'base64']);

/**
 * Stores only secret-question identity metadata owned by the plugin.
 * Answers and question text never enter this file.
 */
export class CodexPrivacyIndex {
  constructor({ rootDir, scope = 'default' } = {}) {
    if (!rootDir) throw new Error('CodexPrivacyIndex requires rootDir');
    this.rootDir = rootDir;
    this.scope = String(scope);
    const scopeFingerprint = createHash('sha256').update(this.scope).digest('hex');
    this.filePath = join(rootDir, `${scopeFingerprint}.json`);
    this.recordPrefix = `${scopeFingerprint}.record.`;
    this.entries = [];
    this.conservativeMasking = false;
    this.conservativeThreadIds = new Set();
    this.threadQuarantines = [];
    this.trustedThreadIds = new Set();
  }

  /** Load the persisted identity index before the first native item arrives. */
  async load({ ignoredRecordName } = {}) {
    const entries = [];
    const conservativeThreadIds = new Set();
    const threadQuarantines = [];
    const trustedThreadIds = new Set();
    let uncertain = false;
    try {
      const names = await readdir(this.rootDir);
      for (const name of names.filter((name) => name === basename(this.filePath)
        || name.startsWith(this.recordPrefix) && name.endsWith('.json'))) {
        if (name === ignoredRecordName && this.#isForkProtectionRecord(name)) continue;
        try {
          const state = readPrivacyState(await readFile(join(this.rootDir, name), 'utf8'));
          entries.push(...state.entries);
          for (const threadId of state.conservativeThreadIds) conservativeThreadIds.add(threadId);
          if (state.conservativeExceptThreadIds) threadQuarantines.push(new Set(state.conservativeExceptThreadIds));
          for (const threadId of state.trustedThreadIds ?? []) trustedThreadIds.add(threadId);
          uncertain ||= state.conservativeMasking;
        } catch {
          uncertain = true;
        }
      }
    } catch (error) {
      uncertain = error?.code !== 'ENOENT';
    }
    this.entries = entries;
    this.conservativeMasking = uncertain;
    this.conservativeThreadIds = conservativeThreadIds;
    this.threadQuarantines = threadQuarantines;
    this.trustedThreadIds = trustedThreadIds;
  }

  async record(identity) {
    const previous = writesByFile.get(this.filePath) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.#recordIdentity(identity));
    writesByFile.set(this.filePath, pending);
    try { await pending; } finally {
      if (writesByFile.get(this.filePath) === pending) writesByFile.delete(this.filePath);
    }
  }

  async #recordIdentity({ threadId = null, turnId = null, callId = null, itemId = null, method, params }) {
    // MCP RPC identity is not a tool-call identity. Without an associated item,
    // protect output in the correlated turn (or thread when turn is unknown).
    if (method === 'mcpServer/elicitation/request' && !itemId) callId = null;
    const request = params?.request ?? params;
    const properties = request?.requestedSchema?.properties;
    const questions = Array.isArray(params?.questions) ? params.questions
      : properties && typeof properties === 'object' ? Object.entries(properties).map(([id, field]) => ({
        id, isSecret: field?.isSecret === true || field?.writeOnly === true || field?.format === 'password',
      })) : [];
    const secretQuestionIds = questions
      .filter((question) => question?.isSecret === true || question?.secret === true)
      .map((question) => question.id)
      .filter((id) => typeof id === 'string' && id.length > 0);
    if (questions.length === 0) return;

    const key = [threadId, turnId, callId, itemId, method].map((value) => String(value ?? '')).join('\u0000');
    await this.load();
    const entry = {
      key,
      threadId,
      turnId,
      callId,
      itemId,
      method,
      secretQuestionIds,
      questionIds: questions.map((question) => question.id).filter((id) => typeof id === 'string'),
      recordedAt: Date.now(),
    };
    // Conservative records remain independently durable. Copying their flag
    // here would make a temporary fork guard permanent during a concurrent turn.
    await this.#appendRecord({ version: 1, entries: [entry] });
    this.entries.push(entry);
  }

  /** Mark only one fork thread conservative without changing its source thread. */
  async markThreadConservative(threadId) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('A conservative privacy marker requires a thread id');
    }
    await this.load();
    if (this.conservativeThreadIds.has(threadId)) return;
    await this.#appendRecord({ version: 1, entries: [], conservativeThreadIds: [threadId] });
    this.conservativeThreadIds.add(threadId);
  }

  /** Protect unknown fork identities while keeping pre-existing threads readable. */
  async beginForkProtection({ knownThreadIds = [], sourceThreadId = null } = {}) {
    const safeIds = [...new Set([...knownThreadIds, sourceThreadId].filter(id => typeof id === 'string' && id.trim()))];
    // v2 is intentionally rejected conservatively by older plugin readers.
    // Unknown outcomes retain this exclusion policy without a persistent lock.
    const name = await this.#appendRecord({ version: 2, entries: [],
      conservativeExceptThreadIds: safeIds, forkTransaction: { sourceThreadId } }, 'fork-pending.');
    await this.load();
    return name;
  }

  /** Only a direct thread/start response or a classified fork establishes this trust. */
  async recordCreatedThread(threadId) {
    if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('Created thread requires an id');
    await this.#appendRecord({ version: 2, entries: [], trustedThreadIds: [threadId] });
    this.trustedThreadIds.add(threadId);
  }

  async recordForkResult(name, forkThreadId) {
    if (!this.#isForkProtectionRecord(name) || typeof forkThreadId !== 'string' || !forkThreadId.trim()) {
      throw new Error('Invalid fork protection identity');
    }
    const state = JSON.parse(await readFile(join(this.rootDir, name), 'utf8'));
    await this.#writeRecord(name, { ...state,
      forkTransaction: { ...state.forkTransaction, forkThreadId } });
  }

  async recordForkBaseline(name, knownThreadIds) {
    if (!this.#isForkProtectionRecord(name)) throw new Error('Invalid fork protection record');
    const state = JSON.parse(await readFile(join(this.rootDir, name), 'utf8'));
    await this.#writeRecord(name, { ...state,
      conservativeExceptThreadIds: [...new Set([...knownThreadIds, state.forkTransaction?.sourceThreadId]
        .filter(id => typeof id === 'string' && id.trim()))] });
    await this.load();
  }

  /** Retain uncertainty as an explicit quarantine, with no lock blocking new forks. */
  async quarantineForkProtection(name) {
    if (!this.#isForkProtectionRecord(name)) throw new Error('Invalid fork protection record');
    const target = name.replace('fork-pending.', 'fork-quarantine.');
    await rename(join(this.rootDir, name), join(this.rootDir, target));
    await this.load();
  }

  /** Old guards lack a baseline: keep their history protected, but retire the obsolete lock. */
  async migrateLegacyForkProtection() {
    let names;
    try { names = await readdir(this.rootDir); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.filter(name => this.#isForkProtectionRecord(name))) {
      let state;
      try { state = JSON.parse(await readFile(join(this.rootDir, name), 'utf8')); }
      catch { continue; } // Loading below keeps corrupt state fail-closed.
      if (state.version === 1 && state.conservativeMasking === true && Array.isArray(state.entries)) {
        await this.#writeRecord(name, { ...state, version: 2, conservativeMasking: false,
          conservativeExceptThreadIds: [] });
      }
    }
    // Legacy lock directories no longer participate in fork admission. Leave
    // them untouched because another process may still be using the old form.
    await this.load();
  }

  async completeForkProtection(name) {
    if (!this.#isForkProtectionRecord(name)) throw new Error('Invalid fork protection record');
    await unlink(join(this.rootDir, name));
    await this.load();
  }

  #isForkProtectionRecord(name) {
    return typeof name === 'string' && basename(name) === name
      && name.startsWith(`${this.recordPrefix}fork-pending.`) && name.endsWith('.json');
  }

  /**
   * Inherit only classifications whose turn and private item identities are
   * demonstrably retained by a native fork. Opaque or incomplete histories
   * mark the fork conservative while leaving the source index untouched.
   */
  async inheritFork({ sourceThreadId, forkThreadId, lastTurnId, sourceTurns, forkTurns, protectionRecord } = {}) {
    if (typeof sourceThreadId !== 'string' || !sourceThreadId.trim()
        || typeof forkThreadId !== 'string' || !forkThreadId.trim()
        || typeof lastTurnId !== 'string' || !lastTurnId.trim()) {
      throw new Error('Fork privacy inheritance requires source thread, fork thread, and lastTurnId');
    }
    if (sourceThreadId === forkThreadId) throw new Error('Fork privacy inheritance requires a distinct thread id');
    // Ignore our own temporary mask only in a private classification snapshot.
    // Concurrent readers and other in-flight forks must retain protection.
    const sourceIndex = protectionRecord
      ? new CodexPrivacyIndex({ rootDir: this.rootDir, scope: this.scope }) : this;
    await sourceIndex.load({ ignoredRecordName: protectionRecord });
    const markConservative = async () => {
      await this.markThreadConservative(forkThreadId);
      return { inherited: 0, conservativeMasking: true };
    };
    if (sourceIndex.isConservativeThread(sourceThreadId)) return markConservative();
    if (!Array.isArray(sourceTurns) || !Array.isArray(forkTurns)) return markConservative();

    const sourceBoundary = sourceTurns.findIndex((turn) => nativeTurnId(turn) === lastTurnId);
    const forkBoundary = forkTurns.findIndex((turn) => nativeTurnId(turn) === lastTurnId);
    if (sourceBoundary < 0 || forkBoundary < 0) return markConservative();
    const sourcePrefix = sourceTurns.slice(0, sourceBoundary + 1);
    const forkPrefix = forkTurns.slice(0, forkBoundary + 1);
    if (sourcePrefix.length !== forkPrefix.length
        || sourcePrefix.some((turn, index) => !nativeTurnId(turn)
          || nativeTurnId(turn) !== nativeTurnId(forkPrefix[index]))) return markConservative();

    const sourceIndexes = new Map(sourceTurns.map((turn, index) => [nativeTurnId(turn), index]));
    const inherited = [];
    let uncertain = false;
    for (const entry of sourceIndex.entries) {
      if (entry.threadId !== sourceThreadId) continue;
      if (!entry.turnId) {
        uncertain = true;
        continue;
      }
      const turnIndex = sourceIndexes.get(entry.turnId);
      if (turnIndex === undefined) {
        // An unobserved classification cannot be proven to fall after the
        // requested boundary, even when it carries an opaque turn id.
        uncertain = true;
        continue;
      }
      if (turnIndex > sourceBoundary) continue;
      if (!entry.itemId && !entry.callId) {
        uncertain = true;
        continue;
      }
      const sourceTurn = sourcePrefix[turnIndex];
      const forkTurn = forkPrefix[turnIndex];
      if (!turnContainsPrivacyIdentity(sourceTurn, entry)
          || !turnContainsPrivacyIdentity(forkTurn, entry)) {
        uncertain = true;
        continue;
      }
      inherited.push({ ...entry, threadId: forkThreadId,
        key: [forkThreadId, entry.turnId, entry.callId, entry.itemId, entry.method]
          .map((value) => String(value ?? '')).join('\u0000') });
    }

    if (inherited.length || uncertain) {
      await this.#appendRecord({ version: 1, entries: inherited,
        ...(uncertain ? { conservativeThreadIds: [forkThreadId] } : {}) });
      this.entries.push(...inherited);
      if (uncertain) this.conservativeThreadIds.add(forkThreadId);
    }
    return { inherited: inherited.length, conservativeMasking: uncertain };
  }

  async #appendRecord(state, namePrefix = '') {
    // Each completed record has a fresh destination. Different Node daemons
    // cannot replace one another's classifications or a corrupt legacy index.
    const name = `${this.recordPrefix}${namePrefix}${randomUUID()}.json`;
    await this.#writeRecord(name, state);
    return name;
  }

  async #writeRecord(name, state) {
    await mkdir(this.rootDir, { recursive: true });
    const targetPath = join(this.rootDir, name);
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state) + '\n', { encoding: 'utf8', flag: 'wx' });
      await rename(tempPath, targetPath);
    } finally {
      await unlink(tempPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }

  /** Whether an item belongs to a recorded secret interaction scope. */
  isSecretIdentity({ threadId = null, turnId = null, callId = null, itemId = null } = {}) {
    return this.matchingEntries({ threadId, turnId, callId, itemId }).some((entry) => entry.secretQuestionIds?.length > 0);
  }

  matchingEntries(identity) {
    const ids = [identity.callId, identity.itemId].filter(Boolean).map(normalizeResultId);
    const matching = this.entries.filter((entry) => {
      if (identity.threadId && entry.threadId && identity.threadId !== entry.threadId) return false;
      if (identity.turnId && entry.turnId && identity.turnId !== entry.turnId) return false;
      const recorded = [entry.callId, entry.itemId].filter(Boolean);
      if (recorded.length) return ids.some((id) => recorded.includes(id));
      return Boolean(identity.threadId && entry.threadId === identity.threadId
        && (entry.turnId ? entry.turnId === identity.turnId
          : entry.method === 'mcpServer/elicitation/request'));
    });
    const strong = matching.filter((entry) => entry.callId || entry.itemId);
    return strong.length ? strong : matching;
  }

  /**
   * Redact plugin-controlled projections of a secret interaction. Identity
   * fields remain visible so stable item upsert and diagnostics still work.
   */
  redact(value, identity = {}) {
    return redactValue(value, identity, this, false);
  }

  /** Return question ids whose answers must remain masked in history projections. */
  secretQuestionIds() {
    return this.entries.flatMap((entry) => entry.secretQuestionIds || []);
  }

  isConservativeThread(threadId) {
    return this.conservativeMasking || Boolean(threadId && this.conservativeThreadIds.has(threadId))
      || this.threadQuarantines.some(safeIds => !threadId
        || !safeIds.has(threadId) && !this.trustedThreadIds.has(threadId));
  }
}

function nativeTurnId(turn) {
  return typeof turn?.id === 'string' ? turn.id
    : typeof turn?.turnId === 'string' ? turn.turnId
      : typeof turn?.turn_id === 'string' ? turn.turn_id : null;
}

function turnContainsPrivacyIdentity(turn, entry) {
  if (!Array.isArray(turn?.items)) return false;
  return turn.items.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const ids = new Set([item.id, item.itemId, item.item_id, item.callId, item.call_id, item.tool_use_id]
      .filter((id) => typeof id === 'string' && id));
    return (!entry.itemId || ids.has(String(entry.itemId)))
      && (!entry.callId || ids.has(String(entry.callId)));
  });
}

const IDENTITY_KEYS = new Set([
  'id', 'type', 'status', 'threadId', 'thread_id', 'turnId', 'turn_id',
  'itemId', 'item_id', 'callId', 'call_id', 'clientId', 'client_id',
  'questionId', 'question_id', 'method', 'server', 'tool', 'name', 'path', 'cwd',
]);

function normalizeResultId(id) {
  return typeof id === 'string' ? id.replace(/:result$/, '') : id;
}

function inheritIdentity(value, parent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parent;
  const turn = Array.isArray(value.items) && value.id;
  return {
    ...parent,
    threadId: value.threadId ?? value.thread_id ?? value.codexThreadId ?? parent.threadId,
    turnId: value.turnId ?? value.turn_id ?? value.codexTurnId ?? (turn ? value.id : parent.turnId),
    itemId: value.itemId ?? value.item_id ?? value.codexItemId
      ?? (typeof value.type === 'string' && value.id ? value.id : turn ? null : parent.itemId),
    callId: value.callId ?? value.call_id ?? value.tool_use_id ?? (turn ? null : parent.callId),
  };
}

function redactValue(value, inherited, index, forcedMask, outputBody = false) {
  const identity = outputBody ? inherited : inheritIdentity(value, inherited);
  const entries = index.matchingEntries(identity);
  // Question names are reused across calls. Only a concrete, matching call in
  // the correct thread can establish that an ordinary answer is safe to show.
  const classified = entries.filter((entry) => identity.threadId && entry.threadId === identity.threadId
    && (!entry.turnId || entry.turnId === identity.turnId) && (entry.callId || entry.itemId));
  const classifiedIds = new Set(classified.flatMap((entry) => entry.questionIds ?? []));
  const secretQuestionIds = new Set(entries.flatMap((entry) => entry.secretQuestionIds ?? []));
  const conservative = index.isConservativeThread(identity.threadId);
  const protectOutput = conservative || secretQuestionIds.size > 0;
  // Classification applies to answers and result bodies. Masking a whole
  // thread would erase reasoning and turn timestamps into invalid strings.
  const mask = forcedMask;
  if (typeof value === 'string') {
    if (outputBody && /"answers"\s*:/.test(value) && /^[{[]/.test(value.trimStart())) {
      try {
        return JSON.stringify(redactValue(JSON.parse(value), identity, index, mask, true));
      } catch { return UNCLASSIFIED_MASK; }
    }
    return mask ? '[redacted secret answer]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, identity, index, forcedMask, outputBody));
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return mask && value !== null && value !== undefined ? '[redacted secret answer]' : value;
  }
  const result = Object.create(null);
  const secretQuestion = [value.id, value.questionId, value.question_id]
    .some((id) => typeof id === 'string' && secretQuestionIds.has(id));
  for (const [key, child] of Object.entries(value)) {
    if (key === 'answers') {
      result.answers = child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).map(([id, answer]) => [id,
          !conservative && classifiedIds.has(id)
            ? secretQuestionIds.has(id) ? '[redacted secret answer]' : answer : UNCLASSIFIED_MASK,
        ])) : UNCLASSIFIED_MASK;
      continue;
    }
    const output = ['output', 'result', 'aggregatedOutput', 'stdout', 'stderr', 'contentItems'].includes(key)
      || key === 'content' && ['tool_result', 'functionCallOutput', 'function_call_output'].includes(value.type)
      || key === 'error' && ['mcpToolCall', 'mcp_tool_call', 'dynamicToolCall'].includes(value.type);
    const childSecret = mask || protectOutput && output || secretQuestion && (key === 'answer' || key === 'value');
    result[key] = !mask && IDENTITY_KEYS.has(key) || mask && key === 'type' && CONTENT_TYPES.has(child)
      ? child
      : redactValue(child, key === 'thread' && child?.id ? { threadId: child.id } : identity, index, childSecret, outputBody || output);
  }
  // Spread creates own data properties even for schema fields such as __proto__.
  return { ...result };
}

function readPrivacyState(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { entries: [], conservativeMasking: true }; }
  if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.entries)) return { entries: [], conservativeMasking: true };
  const entries = parsed.entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && ['threadId', 'turnId', 'callId', 'itemId'].every((key) => entry[key] == null
      || typeof entry[key] === 'string' || typeof entry[key] === 'number' && Number.isFinite(entry[key]))
    && Array.isArray(entry.secretQuestionIds) && entry.secretQuestionIds.every((id) => typeof id === 'string')
    && (entry.questionIds == null || Array.isArray(entry.questionIds) && entry.questionIds.every((id) => typeof id === 'string')));
  const conservativeThreadIds = parsed.conservativeThreadIds === undefined ? [] : parsed.conservativeThreadIds;
  const validConservativeThreadIds = Array.isArray(conservativeThreadIds)
    && conservativeThreadIds.every((id) => typeof id === 'string' && id.length > 0)
    ? conservativeThreadIds : [];
  const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim());
  const safeIds = parsed.conservativeExceptThreadIds;
  const trustedIds = parsed.trustedThreadIds;
  return { entries, conservativeThreadIds: validConservativeThreadIds,
    conservativeExceptThreadIds: validIds(safeIds) ? safeIds : undefined,
    trustedThreadIds: validIds(trustedIds) ? trustedIds : [],
    conservativeMasking: parsed.conservativeMasking === true
    || parsed.conservativeMasking !== undefined && typeof parsed.conservativeMasking !== 'boolean'
    || entries.length !== parsed.entries.length
    || !Array.isArray(conservativeThreadIds) || validConservativeThreadIds.length !== conservativeThreadIds.length
    || safeIds !== undefined && !validIds(safeIds)
    || trustedIds !== undefined && !validIds(trustedIds)
    || parsed.version === 1 && (safeIds !== undefined || trustedIds !== undefined) };
}
