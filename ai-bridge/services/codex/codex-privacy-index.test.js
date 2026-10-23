import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexPrivacyIndex } from './codex-privacy-index.js';

test('a pre-fork guard survives a restart and later classification write failures', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-pending-'));
  const index = new CodexPrivacyIndex({ rootDir });
  const protectionRecord = await index.beginForkProtection();
  await chmod(rootDir, 0o555);
  try {
    const turns = [{ id: 'turn', items: [{ id: 'item', callId: 'call' }] }];
    await assert.rejects(index.markThreadConservative('fork'), error => error.code === 'EACCES');
    // Force inheritance to need a durable fork marker, too.
    await assert.rejects(index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
      lastTurnId: 'missing', sourceTurns: turns, forkTurns: turns, protectionRecord }),
    error => error.code === 'EACCES');
    const reloaded = new CodexPrivacyIndex({ rootDir });
    await reloaded.load();
    assert.equal(reloaded.isConservativeThread('fork'), true);
    assert.doesNotMatch(JSON.stringify(reloaded.redact({ type: 'functionCallOutput',
      output: 'secret copied by fork' }, { threadId: 'fork' })), /secret copied by fork/);
  } finally {
    await chmod(rootDir, 0o755);
    await index.completeForkProtection(protectionRecord);
  }
});

test('completing a fork removes only its temporary guard and retains inherited classifications', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-guard-complete-'));
  const index = new CodexPrivacyIndex({ rootDir });
  await index.record({ threadId: 'source', turnId: 'turn', callId: 'call', itemId: 'item',
    method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', isSecret: true }] } });
  const protectionRecord = await index.beginForkProtection();
  // An ordinary concurrent record must not copy the temporary global mask.
  await index.record({ threadId: 'ordinary', turnId: 'turn', callId: 'normal',
    method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', isSecret: false }] } });
  const turns = [{ id: 'turn', items: [{ id: 'item', callId: 'call' }] }];
  assert.deepEqual(await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'turn', sourceTurns: turns, forkTurns: turns, protectionRecord }),
  { inherited: 1, conservativeMasking: false });
  assert.equal(index.isConservativeThread('unrelated'), true);
  await index.completeForkProtection(protectionRecord);
  const reloaded = new CodexPrivacyIndex({ rootDir });
  await reloaded.load();
  assert.equal(reloaded.isConservativeThread('source'), false);
  assert.equal(reloaded.isConservativeThread('fork'), false);
  assert.equal(reloaded.isSecretIdentity({ threadId: 'fork', turnId: 'turn', itemId: 'item', callId: 'call' }), true);
  assert.match(JSON.stringify(reloaded.redact({ type: 'functionCallOutput', callId: 'normal',
    output: { answers: { q: 'ordinary answer' } } }, { threadId: 'ordinary', turnId: 'turn' })), /ordinary answer/);
});

test('concurrent fork quarantines do not block each other or expose unknown threads', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-two-guards-'));
  const index = new CodexPrivacyIndex({ rootDir });
  const first = await index.beginForkProtection({ knownThreadIds: ['source', 'ordinary'], sourceThreadId: 'source' });
  const otherDaemon = new CodexPrivacyIndex({ rootDir });
  const second = await otherDaemon.beginForkProtection({ knownThreadIds: ['source', 'ordinary'], sourceThreadId: 'source' });
  assert.notEqual(first, second);
  assert.equal(index.isConservativeThread('unknown'), true);
  assert.equal(index.isConservativeThread('source'), false);
  await assert.rejects(index.completeForkProtection('../' + first), /Invalid fork protection record/);
  const turns = [{ id: 'turn', items: [] }];
  assert.deepEqual(await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'turn', sourceTurns: turns, forkTurns: turns, protectionRecord: first }),
  { inherited: 0, conservativeMasking: false });
  await index.completeForkProtection(first);
  assert.equal(index.isConservativeThread('unknown'), true, 'the other in-flight fork still protects unknown threads');
  assert.equal(index.isConservativeThread('fork'), true, 'the second baseline also predates this fork');
  await otherDaemon.completeForkProtection(second);
  await index.load();
  assert.equal(index.isConservativeThread('unknown'), false);
  assert.equal(index.isConservativeThread('fork'), false);
});

test('an uncertain fork stays quarantined while later forks and trusted thread starts proceed', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-quarantine-'));
  const index = new CodexPrivacyIndex({ rootDir });
  const first = await index.beginForkProtection({ knownThreadIds: ['source'], sourceThreadId: 'source' });
  await index.recordForkResult(first, 'unknown-fork');
  await index.quarantineForkProtection(first);
  assert.equal(index.isConservativeThread('source'), false);
  assert.equal(index.isConservativeThread('unknown-fork'), true);

  const next = await index.beginForkProtection({ knownThreadIds: ['source', 'unknown-fork'], sourceThreadId: 'source' });
  await index.recordCreatedThread('new-thread');
  assert.equal(index.isConservativeThread('unknown-fork'), true, 'an earlier quarantine remains authoritative');
  assert.equal(index.isConservativeThread('new-thread'), false);
  await index.markThreadConservative('new-thread');
  assert.equal(index.isConservativeThread('new-thread'), true, 'explicit masks override thread-start trust');
  await index.completeForkProtection(next);

  const reloaded = new CodexPrivacyIndex({ rootDir });
  await reloaded.load();
  assert.equal(reloaded.isConservativeThread('unknown-fork'), true);
  assert.equal(reloaded.isConservativeThread('new-thread'), true);
});

test('legacy global fork guards migrate without blocking and keep unidentified history protected', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-legacy-guard-'));
  const index = new CodexPrivacyIndex({ rootDir });
  const legacyName = `${index.recordPrefix}fork-pending.legacy.json`;
  await writeFile(join(rootDir, legacyName), JSON.stringify({ version: 1, entries: [], conservativeMasking: true }));

  await index.migrateLegacyForkProtection();
  assert.equal(index.isConservativeThread('old-thread'), true);
  await index.recordCreatedThread('new-thread');
  assert.equal(index.isConservativeThread('new-thread'), false);
  const next = await index.beginForkProtection({ knownThreadIds: ['new-thread'], sourceThreadId: 'new-thread' });
  await index.completeForkProtection(next);
  const reloaded = new CodexPrivacyIndex({ rootDir });
  await reloaded.load();
  assert.equal(reloaded.isConservativeThread('old-thread'), true);
  assert.equal(reloaded.isConservativeThread('new-thread'), false);
});

test('redacted native schemas preserve special property names as JSON data', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-schema-')) });
  const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"toString":{"type":"boolean"}}}');
  const redacted = index.redact(schema);
  assert.deepEqual(JSON.parse(JSON.stringify(redacted)), schema);
  assert.equal(Object.getPrototypeOf(redacted.properties), Object.prototype);
});

test('privacy index stores secret identities without question text or answers', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'test' });
  await index.record({
    threadId: 'thread-1',
    turnId: 'turn-1',
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{ id: 'secret-id', question: 'do not persist this', isSecret: true }],
    },
  });
  const files = (await readdir(rootDir)).filter((name) => name.endsWith('.json'));
  const content = (await Promise.all(files.map((name) => readFile(join(rootDir, name), 'utf8')))).join('\n');
  assert.match(content, /secret-id/);
  assert.doesNotMatch(content, /do not persist this/);
  assert.doesNotMatch(content, /answer/);
});

test('privacy index masks matching live item output after a cold reload', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-reload-'));
  const first = new CodexPrivacyIndex({ rootDir, scope: 'reload' });
  await first.record({
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'call-1',
    itemId: 'item-1',
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'secret-id', isSecret: true }] },
  });

  const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'reload' });
  await reloaded.load();
  const masked = reloaded.redact({
    id: 'item-1',
    type: 'functionCallOutput',
    output: { text: 'synthetic-secret-answer', nested: [{ text: 'synthetic-secret-answer' }] },
  }, { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' });
  assert.equal(masked.id, 'item-1');
  assert.equal(masked.output.text, '[redacted secret answer]');
  assert.equal(masked.output.nested[0].text, '[redacted secret answer]');
});

test('secret result payload keys cannot masquerade as outer protocol identities', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-result-keys-')) });
  await index.record({ threadId: 'thread', callId: 'call', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'q', isSecret: true }] } });
  const output = Object.fromEntries(['id', 'name', 'path', 'cwd', 'callId', 'status', 'type'].map((key) => [key, 'synthetic-secret']));
  const safe = index.redact({ id: 'call', type: 'functionCallOutput', status: 'completed', output },
    { threadId: 'thread', callId: 'call' });
  assert.equal(safe.id, 'call');
  assert.equal(safe.type, 'functionCallOutput');
  assert.equal(safe.status, 'completed');
  assert.doesNotMatch(JSON.stringify(safe.output), /synthetic-secret/);
  await index.record({ threadId: 'thread', callId: 'ordinary', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'q' }] } });
  const spoofed = index.redact({ id: 'call', type: 'functionCallOutput',
    output: { callId: 'ordinary', itemId: 'ordinary', answers: { q: 'synthetic-secret' } } }, { threadId: 'thread', callId: 'call' });
  assert.doesNotMatch(JSON.stringify(spoofed.output), /synthetic-secret/);
});

test('corrupt privacy index enables conservative output masking', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-corrupt-'));
  const fileName = `${createHash('sha256').update('corrupt').digest('hex')}.json`;
  await (await import('node:fs/promises')).writeFile(join(rootDir, fileName), '{not-json', 'utf8');
  const index = new CodexPrivacyIndex({ rootDir, scope: 'corrupt' });
  await index.load();
  const masked = index.redact({ id: 'item-1', type: 'functionCallOutput', output: 'unknown output' }, { itemId: 'item-1' });
  assert.equal(masked.id, 'item-1');
  assert.equal(masked.output, '[redacted secret answer]');
});

test('corrupt classification protects results without erasing native history text or structural metadata', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-history-shape-')) });
  await writeFile(index.filePath, '{broken', 'utf8');
  await index.load();
  const raw = { thread: { id: 'thread', title: 'Normal conversation', createdAt: 10, updatedAt: 20,
    turns: [{ id: 'turn', startedAt: 12, status: 'completed', items: [
      { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'User task' }] },
      { id: 'think', type: 'reasoning', summary: [{ text: 'Normal reasoning' }] },
      { id: 'reply', type: 'agentMessage', text: '{"answers":{"q":"Normal reply"}}' },
      { id: 'cmd', type: 'commandExecution', command: 'git status', exitCode: 0, durationMs: 5, aggregatedOutput: 'synthetic-secret' },
      { id: 'dynamic', type: 'dynamicToolCall', tool: 'inspect', status: 'completed', success: true,
        arguments: { query: 'normal input' }, contentItems: [{ type: 'inputText', text: 'synthetic-secret' }] },
    ] }] } };
  const safe = index.redact(raw);
  assert.equal(safe.thread.createdAt, 10);
  assert.equal(safe.thread.updatedAt, 20);
  assert.equal(safe.thread.title, 'Normal conversation');
  const turn = safe.thread.turns[0];
  assert.equal(turn.startedAt, 12);
  assert.equal(turn.items[0].content[0].text, 'User task');
  assert.equal(turn.items[1].summary[0].text, 'Normal reasoning');
  assert.equal(turn.items[2].text, '{"answers":{"q":"Normal reply"}}');
  assert.equal(turn.items[3].command, 'git status');
  assert.equal(turn.items[3].exitCode, 0);
  assert.equal(turn.items[3].durationMs, 5);
  assert.deepEqual(turn.items[4].arguments, { query: 'normal input' });
  assert.equal(turn.items[4].success, true);
  assert.doesNotMatch(JSON.stringify(safe), /synthetic-secret/);
  assert.match(JSON.stringify(raw), /synthetic-secret/);
});

test('recording after index corruption cannot erase uncertainty or release old opaque outputs', async () => {
  for (const content of ['{not-json', '{"version":2,"entries":[],"conservativeExceptThreadIds":"broken"}',
    '{"version":1,"entries":[null]}', '{"version":1,"entries":[],"trustedThreadIds":["untrusted"]}']) {
    const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-repair-'));
    const first = new CodexPrivacyIndex({ rootDir, scope: 'repair' });
    await writeFile(first.filePath, content, 'utf8');
    await first.load();
    await first.record({ threadId: 'new-thread', turnId: 'new-turn', callId: 'new-call',
      method: 'item/tool/requestUserInput', params: { questions: [{ id: 'normal' }] } });
    const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'repair' });
    await reloaded.load();
    const projected = reloaded.redact({ id: 'old-call', type: 'functionCallOutput', output: 'synthetic-secret' },
      { threadId: 'old-thread', turnId: 'old-turn', callId: 'old-call' });
    assert.doesNotMatch(JSON.stringify(projected), /synthetic-secret/);
    assert.equal(projected.id, 'old-call');
    assert.equal(reloaded.conservativeMasking, true);
    assert.doesNotMatch(JSON.stringify(reloaded.redact({ answers: { normal: 'untrusted-answer' } },
      { threadId: 'new-thread', turnId: 'new-turn', callId: 'new-call' })), /untrusted-answer/);
  }
});

test('a malformed entry cannot silently enable ordinary classification for another entry', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-invalid-entry-')) });
  await writeFile(index.filePath, JSON.stringify({ version: 1, entries: [
    { threadId: 't', turnId: 'u', callId: 'known', secretQuestionIds: [], questionIds: ['q'] },
    { threadId: 't', callId: 'lost-secret', secretQuestionIds: 'broken' },
  ] }), 'utf8');
  await index.load();
  assert.doesNotMatch(JSON.stringify(index.redact({ answers: { q: 'synthetic-answer' } },
    { threadId: 't', turnId: 'u', callId: 'known' })), /synthetic-answer/);
});

test('history projections mask recorded secret question ids while preserving identity', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-history-'));
  const first = new CodexPrivacyIndex({ rootDir, scope: 'history' });
  await first.record({
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'call-1',
    method: 'tool/requestUserInput',
    params: { questions: [{ id: 'secret-q', isSecret: true }] },
  });
  const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'history' });
  await reloaded.load();
  const history = reloaded.redact({
    id: 'item-1',
    questions: [{ id: 'secret-q', question: 'Visible question', answer: 'hidden answer' }],
  }, { threadId: 'thread-1', callId: 'call-1' });
  assert.equal(history.id, 'item-1');
  assert.equal(history.questions[0].id, 'secret-q');
  assert.equal(history.questions[0].question, 'Visible question');
  assert.equal(history.questions[0].answer, '[redacted secret answer]');
  assert.deepEqual(reloaded.redact({ id: 'secret-q', text: 'Unrelated text', value: 'ordinary value' },
    { threadId: 'other-thread', callId: 'other-call' }), { id: 'secret-q', text: 'Unrelated text', value: 'ordinary value' });
});

test('MCP RPC ids cannot stand in for tool ids and nullable turns keep opaque answers protected', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-mcp-'));
  const index = new CodexPrivacyIndex({ rootDir });
  await index.record({ threadId: 'thread', turnId: null, callId: 'rpc-42',
    method: 'mcpServer/elicitation/request', params: { requestedSchema: { properties: {
      q: { type: 'string', writeOnly: true },
    } } } });
  const cold = new CodexPrivacyIndex({ rootDir });
  await cold.load();
  assert.equal(cold.entries[0].callId, null);
  const opaque = { type: 'functionCallOutput', id: 'actual-tool-call', output: 'synthetic-secret' };
  assert.doesNotMatch(JSON.stringify(cold.redact(opaque, { threadId: 'thread' })), /synthetic-secret/);
  assert.match(JSON.stringify(cold.redact(opaque, { threadId: 'other-thread' })), /synthetic-secret/);
  assert.equal(cold.redact({ type: 'reasoning', summary: ['plain reasoning'] }, { threadId: 'thread' }).summary[0], 'plain reasoning');
});

test('mixed answer maps keep classified normal answers visible', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-mixed-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'mixed' });
  await index.record({
    threadId: 'thread-1',
    turnId: 'turn-1',
    callId: 'mixed-call',
    method: 'tool/requestUserInput',
    params: { questions: [{ id: 'secret-q', isSecret: true }, { id: 'normal-q' }] },
  });
  const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'mixed' });
  await reloaded.load();

  const projected = reloaded.redact({ answers: {
    'secret-q': 'synthetic-secret',
    'normal-q': 'ordinary-answer',
  } }, { threadId: 'thread-1', turnId: 'turn-1', callId: 'mixed-call' });

  assert.equal(projected.answers['secret-q'], '[redacted secret answer]');
  assert.equal(projected.answers['normal-q'], 'ordinary-answer');
});

test('unknown answer maps are masked when the index is missing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-missing-'));
  const index = new CodexPrivacyIndex({ rootDir });
  await index.load();
  const value = index.redact({ output: '{"answers":{"unknown":"synthetic-secret"}}' });
  assert.doesNotMatch(JSON.stringify(value), /synthetic-secret/);
});

test('ordinary question classification never transfers to a different call, turn or thread', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-call-scope-')) });
  await index.record({ threadId: 'thread', turnId: 'turn', callId: 'known', method: 'tool/requestUserInput',
    params: { questions: [{ id: 'q' }] } });
  for (const identity of [{ threadId: 'other', turnId: 'turn', callId: 'known' },
    { threadId: 'thread', turnId: 'other', callId: 'known' },
    { threadId: 'thread', turnId: 'turn', callId: 'unknown' }, { threadId: 'thread', callId: 'known' }, {}]) {
    assert.match(index.redact({ answers: { q: 'synthetic-unknown-answer' } }, identity).answers.q, /classification unavailable/);
  }
  assert.equal(index.isSecretIdentity({ threadId: 'thread', turnId: 'turn', callId: 'known' }), false);
  assert.equal(index.redact({ type: 'reasoning', id: 'reason', summary: ['plain reasoning'] },
    { threadId: 'thread', turnId: 'turn' }).summary[0], 'plain reasoning');
  assert.match(index.redact({ output: '{"answers":{"q":"synthetic-unknown-answer"}' }).output, /classification unavailable/);
});

test('nested native history discovers each call before masking shared question names', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-nested-')) });
  for (const [callId, isSecret] of [['ordinary', false], ['secret', true]]) await index.record({
    threadId: 'thread', turnId: 'turn', callId, method: 'tool/requestUserInput', params: { questions: [{ id: 'q', isSecret }] },
  });
  await index.record({ threadId: 'thread', turnId: 'turn', method: 'mcpServer/elicitation/request',
    params: { questions: [{ id: 'q', isSecret: true }] } });
  const value = { thread: { id: 'thread', turns: [{ id: 'turn', items: ['ordinary', 'secret', 'unknown'].map((id) => ({
    id, type: 'functionCallOutput', output: JSON.stringify({ answers: { q: id === 'ordinary' ? 'public-answer' : 'synthetic-secret-answer' } }),
  })) }] } };
  const serialized = JSON.stringify(index.redact(value, { threadId: 'thread' }));
  assert.match(serialized, /public-answer/);
  assert.doesNotMatch(serialized, /synthetic-secret-answer/);
});

test('concurrent writers preserve both identity records in the shared home scope', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-concurrent-'));
  const first = new CodexPrivacyIndex({ rootDir });
  const second = new CodexPrivacyIndex({ rootDir });
  await Promise.all([first.record({ threadId: 'one', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'first-secret', isSecret: true }] } }),
  second.record({ threadId: 'two', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'second-secret', isSecret: true }] } })]);
  await first.load();
  assert.equal(first.entries.length, 2);
});

test('separate daemon processes never overwrite another windows secret classification', { timeout: 20_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-processes-'));
  const children = [];
  const moduleUrl = new URL('./codex-privacy-index.js', import.meta.url).href;
  try {
    for (let writer = 0; writer < 4; writer++) {
      const code = `import { CodexPrivacyIndex } from ${JSON.stringify(moduleUrl)};
        const index = new CodexPrivacyIndex({ rootDir: ${JSON.stringify(rootDir)}, scope: 'shared' });
        process.stdout.write('ready\\n');
        process.stdin.once('data', async () => {
          for (let call = 0; call < 20; call++) await index.record({ threadId: 'thread-${writer}',
            turnId: 'turn', callId: 'call-' + call, method: 'item/tool/requestUserInput',
            params: { questions: [{ id: 'q', isSecret: true }] } });
          process.stdin.destroy();
        });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const done = new Promise((resolve, reject) => {
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(diagnostics || `writer exited ${status}`)));
      });
      // Observe early exits before awaiting the batch so a failed startup cannot
      // strand the readiness wait or produce an unhandled rejection.
      done.catch(() => {});
      children.push({ child, done });
      await Promise.race([new Promise((resolve) => child.stdout.once('data', resolve)),
        done.then(() => { throw new Error('writer exited before readiness'); })]);
    }
    for (const { child } of children) child.stdin.end('go');
    await Promise.all(children.map(({ done }) => done));
    const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'shared' });
    await reloaded.load();
    assert.equal(reloaded.entries.length, 80);
    for (let writer = 0; writer < 4; writer++) {
      for (let call = 0; call < 20; call++) {
        assert.doesNotMatch(JSON.stringify(reloaded.redact({ output: 'synthetic-secret' },
          { threadId: `thread-${writer}`, turnId: 'turn', callId: `call-${call}` })), /synthetic-secret/);
      }
    }
  } finally {
    for (const { child } of children) if (child.exitCode == null) child.kill();
    await Promise.allSettled(children.map(({ done }) => done));
  }
});

test('reasoning prose survives answer syntax while JSON answer fragments never release secrets', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-prose-')) });
  const prose = 'Explain the "answers": field before writing the request.';
  assert.equal(index.redact({ type: 'reasoning', summary: [prose] }).summary[0], prose);
  for (const output of ['{"answers":{"q":"synthetic-secret', '[{"answers":{"q":"synthetic-secret"}}]']) {
    assert.doesNotMatch(JSON.stringify(index.redact({ output })), /synthetic-secret/);
  }
});

test('invalid answer containers cannot bypass masking through raw output', async () => {
  const index = new CodexPrivacyIndex({ rootDir: await mkdtemp(join(tmpdir(), 'codex-privacy-malformed-')) });
  for (const answers of ['synthetic-secret', ['synthetic-secret'], 42]) {
    assert.doesNotMatch(JSON.stringify(index.redact({ output: JSON.stringify({ answers }) })), /synthetic-secret|42/);
  }
});

test('fork inherits only identity-mapped classifications through the inclusive last turn', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-fork-boundary-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'fork-boundary' });
  await index.record({ threadId: 'source', turnId: 'turn-before', itemId: 'item-before',
    callId: 'call-before', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'secret-before', isSecret: true }] } });
  await index.record({ threadId: 'source', turnId: 'turn-after', itemId: 'item-after',
    callId: 'call-after', method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'secret-after', isSecret: true }] } });
  const sourceTurns = [
    { id: 'turn-before', items: [{ id: 'item-before', callId: 'call-before' }] },
    { id: 'turn-after', items: [{ id: 'item-after', callId: 'call-after' }] },
  ];
  const result = await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'turn-before', sourceTurns, forkTurns: sourceTurns.slice(0, 1) });

  assert.deepEqual(result, { inherited: 1, conservativeMasking: false });
  const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'fork-boundary' });
  await reloaded.load();
  assert.deepEqual(reloaded.entries.filter((entry) => entry.threadId === 'fork').map((entry) => entry.turnId), ['turn-before']);
  assert.equal(reloaded.isConservativeThread('source'), false);
  assert.equal(reloaded.isConservativeThread('fork'), false);
});

test('fork privacy inheritance fails closed when a boundary or mapping is unavailable', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-fork-invalid-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'fork-invalid' });
  await assert.rejects(index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    sourceTurns: [], forkTurns: [] }), /lastTurnId/);
  await assert.rejects(index.inheritFork({ sourceThreadId: 'same', forkThreadId: 'same', lastTurnId: 'turn',
    sourceTurns: [{ id: 'turn', items: [] }], forkTurns: [{ id: 'turn', items: [] }] }), /distinct thread id/);
  const result = await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork', lastTurnId: 'missing',
    sourceTurns: [{ id: 'turn', items: [] }], forkTurns: [{ id: 'turn', items: [] }] });
  assert.deepEqual(result, { inherited: 0, conservativeMasking: true });
  assert.equal(index.isConservativeThread('source'), false);
  assert.equal(index.isConservativeThread('fork'), true);
});

test('unmappable fork classifications mask only the fork thread after reload', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-fork-conservative-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'fork-conservative' });
  await index.record({ threadId: 'source', turnId: 'turn-1', callId: 'call-1', itemId: 'item-1',
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'question', isSecret: true }] } });
  await index.record({ threadId: 'source', turnId: 'turn-1', callId: 'ordinary', itemId: 'ordinary-item',
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'ordinary', isSecret: false }] } });
  const result = await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'turn-1', sourceTurns: [{ id: 'turn-1', items: [{ id: 'item-1', callId: 'call-1' }] }],
    forkTurns: [{ id: 'turn-1', items: [{ id: 'different-item', callId: 'different-call' }] }] });

  assert.deepEqual(result, { inherited: 0, conservativeMasking: true });
  const reloaded = new CodexPrivacyIndex({ rootDir, scope: 'fork-conservative' });
  await reloaded.load();
  assert.equal(reloaded.isConservativeThread('source'), false);
  assert.equal(reloaded.isConservativeThread('fork'), true);
  const sourceOutput = reloaded.redact({ type: 'functionCallOutput', callId: 'ordinary',
    output: { answers: { ordinary: 'source answer' } } }, { threadId: 'source', turnId: 'turn-1', callId: 'ordinary' });
  const forkOutput = reloaded.redact({ type: 'functionCallOutput', callId: 'ordinary',
    output: { answers: { ordinary: 'fork answer' } } }, { threadId: 'fork', turnId: 'turn-1', callId: 'ordinary' });
  assert.match(JSON.stringify(sourceOutput), /source answer/);
  assert.doesNotMatch(JSON.stringify(forkOutput), /fork answer/);
});

test('fork masks only the fork when a source classification turn is absent from history', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-fork-missing-turn-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'fork-missing-turn' });
  await index.record({ threadId: 'source', turnId: 'unavailable-turn', callId: 'call-1', itemId: 'item-1',
    method: 'item/tool/requestUserInput', params: { questions: [{ id: 'secret', isSecret: true }] } });

  const turns = [{ id: 'boundary-turn', items: [] }];
  const result = await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'boundary-turn', sourceTurns: turns, forkTurns: turns });

  assert.deepEqual(result, { inherited: 0, conservativeMasking: true });
  assert.equal(index.isConservativeThread('source'), false);
  assert.equal(index.isConservativeThread('fork'), true);
});

test('fork classifications and its conservative marker persist in one atomic record', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'codex-privacy-fork-atomic-'));
  const index = new CodexPrivacyIndex({ rootDir, scope: 'fork-atomic' });
  for (const [itemId, callId] of [['mapped-item', 'mapped-call'], ['unmapped-item', 'unmapped-call']]) {
    await index.record({ threadId: 'source', turnId: 'turn-1', itemId, callId,
      method: 'item/tool/requestUserInput', params: { questions: [{ id: itemId, isSecret: true }] } });
  }
  const sourceTurns = [{ id: 'turn-1', items: [
    { id: 'mapped-item', callId: 'mapped-call' }, { id: 'unmapped-item', callId: 'unmapped-call' },
  ] }];
  const forkTurns = [{ id: 'turn-1', items: [{ id: 'mapped-item', callId: 'mapped-call' },
    { id: 'different-item', callId: 'different-call' }] }];

  const result = await index.inheritFork({ sourceThreadId: 'source', forkThreadId: 'fork',
    lastTurnId: 'turn-1', sourceTurns, forkTurns });

  assert.deepEqual(result, { inherited: 1, conservativeMasking: true });
  const records = await Promise.all((await readdir(rootDir)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(join(rootDir, name), 'utf8'))));
  const forkRecord = records.find(record => record.conservativeThreadIds?.includes('fork'));
  assert.ok(forkRecord);
  assert.deepEqual(forkRecord.entries.map(entry => entry.threadId), ['fork']);
});
