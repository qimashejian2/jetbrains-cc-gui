package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Verifies native Codex control commands fail truthfully before a thread exists. */
public class CodexSDKBridgeCommandTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void compactWithoutThreadReturnsActionableError() throws Exception {
        CodexSDKBridge bridge = new CodexSDKBridge(temporaryFolder.newFolder("sessions").toPath());

        JsonObject result = bridge.compactCodex("channel", temporaryFolder.getRoot().getAbsolutePath(), "")
                .get();

        assertTrue(result.has("error"));
        assertTrue(result.get("error").getAsString().contains("Start a Codex conversation"));
    }

    @Test
    public void forkWaitIncludesHistoryAndPrivacyProcessingTime() {
        assertEquals(120_000L, CodexSDKBridge.nativeCommandTimeoutMs("codex.fork"));
        assertEquals(30_000L, CodexSDKBridge.nativeCommandTimeoutMs("codex.queueAdd"));
    }

    @Test
    public void queueAndForkUseNativeCommandsAndReuseRequestIdForQueueAdd() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        CodexSDKBridge bridge = createBridge(daemon);
        JsonArray input = new JsonArray();
        JsonObject text = new JsonObject();
        text.addProperty("type", "text");
        text.addProperty("text", "queued text");
        input.add(text);
        try {
            bridge.queueCodexMessage("channel", "C:/repo", "thread-1", input, "webview-request-1").get();
            bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();
            bridge.mutateCodexQueue("update", "channel", "C:/repo", "thread-1", params("queuedSubmissionId", "item-1", input)).get();
            bridge.mutateCodexQueue("delete", "channel", "C:/repo", "thread-1", params("queuedSubmissionId", "item-1", null)).get();
            bridge.mutateCodexQueue("reorder", "channel", "C:/repo", "thread-1", params("queuedSubmissionIds", new JsonArray(), null)).get();
            bridge.startCodexQueue("channel", "C:/repo", "thread-1", "item-1").get();
            JsonObject fork = bridge.forkCodexThread("channel", "C:/repo", "thread-1", "turn-1").get();

            assertEquals(List.of("codex.queueAdd", "codex.queueList", "codex.queueUpdate",
                    "codex.queueDelete", "codex.queueReorder", "codex.queueStart", "codex.fork"), daemon.methods());
            JsonObject addParams = daemon.params.get(0).getAsJsonObject("params");
            assertEquals("webview-request-1", addParams.get("clientUserMessageId").getAsString());
            assertEquals("thread-1", addParams.get("threadId").getAsString());
            assertEquals(input, addParams.getAsJsonArray("input"));
            assertEquals("turn-1", daemon.params.get(6).getAsJsonObject("params").get("lastTurnId").getAsString());
            assertEquals("forked-thread", fork.getAsJsonObject("result").get("thread").getAsJsonObject().get("id").getAsString());
            assertTrue(fork.get("error").isJsonNull());
            assertTrue(fork.get("code").isJsonNull());
            assertTrue("forking a branch does not claim a writer before that branch is opened",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread") == null);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueListUsesLoadedRuntimeWithoutPreconnectingForNullErrorSuccessEnvelope() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject listed = bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();

            assertEquals(List.of("codex.queueList"), daemon.methods());
            assertEquals("loaded thread queue list returns directly", "codex.queueList",
                    listed.getAsJsonObject("result").get("method").getAsString());
            assertTrue("reading an already loaded thread does not need a new lease",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "thread-1") == null);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueListRecoversNoRuntimeAndStaleThreadWithOnePreconnectAndRetry() throws Exception {
        for (String errorCode : List.of("NO_RUNTIME", "STALE_THREAD")) {
            RecordingDaemon daemon = new RecordingDaemon();
            daemon.queueListFailureCode = errorCode;
            CodexSDKBridge bridge = createBridge(daemon);
            try {
                JsonObject listed = bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();

                assertEquals(List.of("codex.queueList", "codex.preconnect", "codex.queueList"), daemon.methods());
                assertEquals("thread-1", daemon.params.get(1).get("threadId").getAsString());
                assertTrue(listed.get("success").getAsBoolean());
                assertTrue("successful recovery establishes this window's writer lease",
                        CodexThreadOwnerRegistry.ownerOf("command-test", "thread-1") != null);
            } finally {
                bridge.cleanupAllProcesses();
            }
        }
    }

    @Test
    public void lateQueueMissCannotPreconnectReleasedEpochOrDisturbNewThread() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.holdNextQueueList = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            CompletableFuture<JsonObject> oldQueueList = bridge.listCodexQueue(
                    "channel", "C:/repo", "thread-a");
            assertTrue("initial queue request reaches the daemon", daemon.queueListDispatched.await(5, TimeUnit.SECONDS));
            String oldEpoch = daemon.params.get(0).get("sessionEpoch").getAsString();

            bridge.releaseCodexThread("channel", "C:/repo", "thread-a").get();
            bridge.readCodexNative("codex.readHistoryPage", "channel", "C:/repo", "thread-b", null).get();
            String newEpoch = daemon.params.get(2).get("sessionEpoch").getAsString();
            assertFalse("the new reader is dispatched with a fresh channel epoch", oldEpoch.equals(newEpoch));
            bridge.preconnectCodex("channel", "C:/repo", "thread-b").get();

            daemon.pendingQueueList.completeQueueMiss("NO_RUNTIME");
            JsonObject lateResult = oldQueueList.get();

            assertEquals("NO_RUNTIME", lateResult.get("code").getAsString());
            assertEquals(List.of("codex.queueList", "codex.releaseThread", "codex.readHistoryPage", "codex.preconnect"),
                    daemon.methods());
            assertEquals(oldEpoch, daemon.params.get(0).get("sessionEpoch").getAsString());
            assertEquals(oldEpoch, daemon.params.get(1).get("sessionEpoch").getAsString());
            assertEquals(newEpoch, daemon.params.get(2).get("sessionEpoch").getAsString());
            assertEquals(newEpoch, daemon.params.get(3).get("sessionEpoch").getAsString());
            assertNotNull("the newly opened thread keeps its writer lease",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "thread-b"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueMissDuringReleaseCannotRecoverTheEpochBeingReleased() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.holdNextQueueList = true;
        daemon.holdNextRelease = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            CompletableFuture<JsonObject> oldQueueList = bridge.listCodexQueue(
                    "channel", "C:/repo", "thread-a");
            assertTrue("initial queue request reaches the daemon", daemon.queueListDispatched.await(5, TimeUnit.SECONDS));
            String oldEpoch = daemon.params.get(0).get("sessionEpoch").getAsString();

            CompletableFuture<JsonObject> release = bridge.releaseCodexThread("channel", "C:/repo", "thread-a");
            assertTrue("release starts before the queue miss returns", daemon.releaseDispatched.await(5, TimeUnit.SECONDS));
            daemon.pendingQueueList.completeQueueMiss("STALE_THREAD");
            JsonObject oldResult = oldQueueList.get();

            assertEquals("STALE_THREAD", oldResult.get("code").getAsString());
            assertEquals("an in-flight release blocks recovery of its own epoch",
                    List.of("codex.queueList", "codex.releaseThread"), daemon.methods());

            daemon.pendingRelease.completeRelease();
            release.get();
            bridge.preconnectCodex("channel", "C:/repo", "thread-b").get();

            assertEquals(List.of("codex.queueList", "codex.releaseThread", "codex.preconnect"), daemon.methods());
            assertEquals(oldEpoch, daemon.params.get(0).get("sessionEpoch").getAsString());
            assertEquals(oldEpoch, daemon.params.get(1).get("sessionEpoch").getAsString());
            assertFalse(oldEpoch.equals(daemon.params.get(2).get("sessionEpoch").getAsString()));
            assertNotNull("newly opened epoch can claim a writer after release completes",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "thread-b"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueListReturnsPreconnectFailureAfterRuntimeMissWithoutRetrying() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.queueListFailureCode = "NO_RUNTIME";
        daemon.failPreconnect = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject failed = bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();

            assertEquals(List.of("codex.queueList", "codex.preconnect"), daemon.methods());
            JsonObject expectedFailure = new JsonObject();
            expectedFailure.addProperty("success", false);
            expectedFailure.addProperty("error", "fixture preconnect failed");
            assertEquals(expectedFailure, failed);
            assertTrue("failed preconnect releases its provisional lease",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "thread-1") == null);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueListRuntimeMissPreservesConflictingWindowLeaseWithoutPreconnectCommand() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.queueListFailureCode = "STALE_THREAD";
        CodexSDKBridge bridge = createBridge(daemon);
        CodexThreadOwnerRegistry.claim("command-test", "thread-1", "other-window");
        try {
            JsonObject conflict = bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();

            assertTrue(conflict.get("error").getAsString().contains("already owned by another window"));
            assertEquals(List.of("codex.queueList"), daemon.methods());
            assertEquals("other-window", CodexThreadOwnerRegistry.ownerOf("command-test", "thread-1"));
        } finally {
            CodexThreadOwnerRegistry.releaseAll("command-test", "thread-1", "other-window");
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void queueListDoesNotPreconnectForOtherErrorsOrBlankThreadIds() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.queueListFailureCode = "UNSUPPORTED";
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject failed = bridge.listCodexQueue("channel", "C:/repo", "thread-1").get();
            assertEquals("UNSUPPORTED", failed.get("code").getAsString());
            assertEquals(List.of("codex.queueList"), daemon.methods());

            JsonObject invalid = bridge.listCodexQueue("channel", "C:/repo", "  ").get();
            assertEquals("INVALID_PARAMS", invalid.get("code").getAsString());
            assertEquals(List.of("codex.queueList"), daemon.methods());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void forkRequiresAnExplicitBoundaryAndAValidNewThreadId() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.missingForkId = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject missingBoundary = bridge.forkCodexThread("channel", "C:/repo", "thread-1", " ").get();
            assertEquals("INVALID_PARAMS", missingBoundary.get("code").getAsString());
            assertTrue("invalid fork input is rejected before native dispatch", daemon.methods().isEmpty());

            JsonObject missingId = bridge.forkCodexThread("channel", "C:/repo", "thread-1", "turn-1").get();
            assertEquals("INVALID_RESPONSE", missingId.get("code").getAsString());
            assertEquals("codex.fork", daemon.methods().get(0));
            assertTrue(CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread") == null);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void forkedThreadCanBeClaimedByAnotherOwnerUntilThisWindowOpensIt() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject fork = bridge.forkCodexThread("channel", "C:/repo", "thread-1", "turn-1").get();
            assertTrue(fork.get("success").getAsBoolean());
            assertTrue(CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread") == null);

            assertTrue(CodexThreadOwnerRegistry.claim("command-test", "forked-thread", "other-window").acquired());
            assertEquals("other-window", CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread"));
            CodexThreadOwnerRegistry.releaseAll("command-test", "forked-thread", "other-window");

            bridge.preconnectCodex("channel", "C:/repo", "forked-thread").get();
            assertNotNull("opening the branch claims its writer lease",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void delayedForkResultDoesNotStealAnAlreadyClaimedThreadLease() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.holdNextFork = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            CompletableFuture<JsonObject> forkFuture = bridge.forkCodexThread(
                    "channel", "C:/repo", "thread-1", "turn-1");
            assertTrue("fork request reaches the daemon", daemon.forkDispatched.await(5, TimeUnit.SECONDS));
            assertTrue(CodexThreadOwnerRegistry.claim("command-test", "forked-thread", "other-window").acquired());

            daemon.pendingFork.completeFork();
            JsonObject fork = forkFuture.get();

            assertTrue("the successful late fork response remains usable", fork.get("success").getAsBoolean());
            assertEquals("late fork completion must not overwrite another window's lease", "other-window",
                    CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread"));
        } finally {
            CodexThreadOwnerRegistry.releaseAll("command-test", "forked-thread", "other-window");
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void forkRejectsFailureEnvelopeEvenWhenErrorIsNull() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.failedForkWithoutError = true;
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject failed = bridge.forkCodexThread("channel", "C:/repo", "thread-1", "turn-1").get();

            assertFalse(failed.get("success").getAsBoolean());
            assertTrue(failed.get("error").isJsonNull());
            assertTrue(CodexThreadOwnerRegistry.ownerOf("command-test", "forked-thread") == null);
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void steerCarriesExpectedTurnAndKeepsNativeErrorCode() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        daemon.rejectFork = true;
        CodexSDKBridge bridge = createBridge(daemon);
        JsonArray input = new JsonArray();
        JsonObject text = new JsonObject();
        text.addProperty("type", "text");
        text.addProperty("text", "steer input");
        input.add(text);
        try {
            bridge.steerCodexTurn("channel", "C:/repo", "thread-1", "turn-expected", input);
            JsonObject rejected = bridge.forkCodexThread("channel", "C:/repo", "thread-1", "turn-1").get();

            assertEquals("steer preserves the expected native turn ID", "turn-expected",
                    daemon.params.get(0).getAsJsonObject("params").get("expectedTurnId").getAsString());
            assertEquals(input, daemon.params.get(0).getAsJsonObject("params").getAsJsonArray("input"));
            assertEquals("UNSUPPORTED", rejected.get("code").getAsString());
            assertEquals("fixture rejected thread/fork", rejected.get("error").getAsString());
            assertEquals("thread/fork", rejected.getAsJsonObject("result").get("method").getAsString());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void readOnlyNativeFacadeRejectsQueueMethodsWithoutSendingThem() throws Exception {
        RecordingDaemon daemon = new RecordingDaemon();
        CodexSDKBridge bridge = createBridge(daemon);
        try {
            JsonObject result = bridge.readCodexNative("codex.queueList", "channel", "C:/repo", "thread-1", null).get();

            assertEquals("UNSUPPORTED", result.get("code").getAsString());
            assertTrue(result.has("error"));
            assertTrue(daemon.methods().isEmpty());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    private CodexSDKBridge createBridge(RecordingDaemon daemon) throws Exception {
        Supplier<DaemonBridge> daemonFactory = () -> daemon;
        return new CodexSDKBridge(this.temporaryFolder.newFolder("sessions-" + System.nanoTime()).toPath(),
                new FixtureSettings(), daemonFactory, "command-test");
    }

    private static JsonObject params(String name, Object value, JsonArray input) {
        JsonObject params = new JsonObject();
        if (value instanceof String text) params.addProperty(name, text);
        else if (value instanceof JsonArray array) params.add(name, array);
        if (input != null) params.add("input", input.deepCopy());
        return params;
    }

    private static final class FixtureSettings extends CodemossSettingsService {
        @Override public String getCodexRuntimeAccessMode() { return CODEX_RUNTIME_ACCESS_CLI_LOGIN; }
        @Override public JsonObject getActiveCodexProvider() { return new JsonObject(); }
    }

    private static final class RecordingDaemon extends DaemonBridge {
        private final List<String> methodNames = new CopyOnWriteArrayList<>();
        private final List<JsonObject> params = new CopyOnWriteArrayList<>();
        private final CountDownLatch queueListDispatched = new CountDownLatch(1);
        private final CountDownLatch forkDispatched = new CountDownLatch(1);
        private final CountDownLatch releaseDispatched = new CountDownLatch(1);
        private boolean rejectFork;
        private boolean missingForkId;
        private boolean failedForkWithoutError;
        private boolean failPreconnect;
        private volatile boolean holdNextQueueList;
        private volatile boolean holdNextFork;
        private volatile boolean holdNextRelease;
        private String queueListFailureCode;
        private boolean queueListFailureSent;
        private volatile PendingCommand pendingQueueList;
        private volatile PendingCommand pendingFork;
        private volatile PendingCommand pendingRelease;

        private RecordingDaemon() { super(null, null, null); }

        @Override public boolean start() { return true; }
        @Override public boolean isAlive() { return true; }

        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject sentParams, DaemonOutputCallback callback) {
            this.methodNames.add(method);
            this.params.add(sentParams.deepCopy());
            if ("codex.queueList".equals(method) && this.holdNextQueueList) {
                this.holdNextQueueList = false;
                this.pendingQueueList = new PendingCommand(callback);
                this.queueListDispatched.countDown();
                return this.pendingQueueList.transport;
            }
            if ("codex.fork".equals(method) && this.holdNextFork) {
                this.holdNextFork = false;
                this.pendingFork = new PendingCommand(callback);
                this.forkDispatched.countDown();
                return this.pendingFork.transport;
            }
            if ("codex.releaseThread".equals(method) && this.holdNextRelease) {
                this.holdNextRelease = false;
                this.pendingRelease = new PendingCommand(callback);
                this.releaseDispatched.countDown();
                return this.pendingRelease.transport;
            }
            JsonObject result = new JsonObject();
            if ("codex.queueList".equals(method) && this.queueListFailureCode != null
                    && !this.queueListFailureSent) {
                this.queueListFailureSent = true;
                JsonObject failure = new JsonObject();
                failure.addProperty("id", "fixture-id");
                failure.addProperty("done", true);
                failure.addProperty("success", false);
                failure.addProperty("error", "fixture queue runtime miss");
                failure.addProperty("code", this.queueListFailureCode);
                failure.add("result", JsonNull.INSTANCE);
                callback.onResult(failure);
                callback.onComplete(false);
                return CompletableFuture.completedFuture(false);
            }
            if ("codex.preconnect".equals(method) && this.failPreconnect) {
                result.addProperty("method", method);
                JsonObject failure = new JsonObject();
                failure.addProperty("id", "fixture-id");
                failure.addProperty("done", true);
                failure.addProperty("success", false);
                failure.addProperty("error", "fixture preconnect failed");
                failure.addProperty("code", "UNAVAILABLE");
                failure.add("result", result);
                callback.onResult(failure);
                callback.onError(failure.get("error").getAsString());
                callback.onComplete(false);
                return CompletableFuture.completedFuture(false);
            }
            if ("codex.fork".equals(method)) {
                if (this.rejectFork) {
                    result.addProperty("method", "thread/fork");
                    JsonObject error = new JsonObject();
                    error.addProperty("id", "fixture-id");
                    error.addProperty("done", true);
                    error.addProperty("success", false);
                    error.addProperty("error", "fixture rejected thread/fork");
                    error.addProperty("code", "UNSUPPORTED");
                    error.add("result", result);
                    callback.onResult(error);
                    callback.onError(error.get("error").getAsString());
                    callback.onComplete(false);
                    return CompletableFuture.failedFuture(new RuntimeException("fixture rejected thread/fork"));
                }
                if (this.failedForkWithoutError) {
                    JsonObject failure = new JsonObject();
                    failure.addProperty("id", "fixture-id");
                    failure.addProperty("done", true);
                    failure.addProperty("success", false);
                    failure.add("error", JsonNull.INSTANCE);
                    failure.add("code", JsonNull.INSTANCE);
                    failure.add("result", JsonNull.INSTANCE);
                    callback.onResult(failure);
                    callback.onComplete(false);
                    return CompletableFuture.completedFuture(false);
                }
                JsonObject thread = new JsonObject();
                if (!this.missingForkId) thread.addProperty("id", "forked-thread");
                result.add("thread", thread);
            } else {
                result.addProperty("method", method);
            }
            JsonObject response = new JsonObject();
            response.addProperty("id", "fixture-id");
            response.addProperty("done", true);
            response.addProperty("success", true);
            response.add("result", result);
            response.add("error", JsonNull.INSTANCE);
            response.add("code", JsonNull.INSTANCE);
            callback.onResult(response);
            callback.onComplete(true);
            return CompletableFuture.completedFuture(true);
        }

        private List<String> methods() { return List.copyOf(this.methodNames); }

        private static final class PendingCommand {
            private final DaemonOutputCallback callback;
            private final CompletableFuture<Boolean> transport = new CompletableFuture<>();

            private PendingCommand(DaemonOutputCallback callback) {
                this.callback = callback;
            }

            private void completeQueueMiss(String code) {
                JsonObject failure = new JsonObject();
                failure.addProperty("id", "fixture-id");
                failure.addProperty("done", true);
                failure.addProperty("success", false);
                failure.addProperty("error", "fixture queue runtime miss");
                failure.addProperty("code", code);
                failure.add("result", JsonNull.INSTANCE);
                this.complete(failure, false);
            }

            private void completeFork() {
                JsonObject result = new JsonObject();
                JsonObject thread = new JsonObject();
                thread.addProperty("id", "forked-thread");
                result.add("thread", thread);
                JsonObject response = new JsonObject();
                response.addProperty("id", "fixture-id");
                response.addProperty("done", true);
                response.addProperty("success", true);
                response.add("result", result);
                response.add("error", JsonNull.INSTANCE);
                response.add("code", JsonNull.INSTANCE);
                this.complete(response, true);
            }

            private void completeRelease() {
                JsonObject result = new JsonObject();
                result.addProperty("method", "codex.releaseThread");
                JsonObject response = new JsonObject();
                response.addProperty("id", "fixture-id");
                response.addProperty("done", true);
                response.addProperty("success", true);
                response.add("result", result);
                response.add("error", JsonNull.INSTANCE);
                response.add("code", JsonNull.INSTANCE);
                this.complete(response, true);
            }

            private void complete(JsonObject response, boolean success) {
                this.callback.onResult(response);
                this.callback.onComplete(success);
                this.transport.complete(success);
            }
        }
    }
}
