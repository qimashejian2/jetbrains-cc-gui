package com.github.claudecodegui.provider.common;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

/** Exercises the production Java daemon transport, Node service and stdio peer together. */
public class CodexDaemonTransportIntegrationTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void approvalReplyReachesPeerBeforeTheSendCompletes() throws Exception {
        this.exercise("reverse-approval", false);
    }

    @Test
    public void nativeEofIsReportedAsFailureInsteadOfSuccessfulSend() throws Exception {
        this.exercise("disconnect-mid-turn", true);
    }

    @Test
    public void nativeInterruptIsAGracefulUnsuccessfulCompletion() throws Exception {
        this.exercise("never-respond", false);
    }

    @Test
    public void nativeHistoryAndChildStatusStayReadOnlyAndReleaseReapsThePeer() throws Exception {
        this.exercise("native-read-only", false);
    }

    @Test
    public void nativeQueueSteerAndForkCommandsBypassThePendingSend() throws Exception {
        Path repository = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path home = this.folder.newFolder("native-controls-home").toPath();
        Path cwd = this.folder.newFolder("native-controls-workspace").toPath();
        Path trace = home.resolve("peer-trace.ndjson");
        AtomicReference<Process> process = new AtomicReference<>();
        CodexFixtureDaemon daemon = new CodexFixtureDaemon(repository, home, "never-respond", trace, process);
        List<JsonObject> events = new CopyOnWriteArrayList<>();
        daemon.addEventListener((kind, data) -> {
            if ("codex_event".equals(kind)) events.add(data.deepCopy());
        });
        try {
            assertTrue(daemon.start());
            JsonObject sendParams = new JsonObject();
            sendParams.addProperty("channelId", "native-control-test");
            sendParams.addProperty("sessionEpoch", "test-epoch");
            sendParams.addProperty("cwd", cwd.toString());
            sendParams.addProperty("message", "keep this turn pending");
            sendParams.addProperty("clientMessageId", "fixture-client-id");
            var send = daemon.sendCommand("codex.send", sendParams, new Sink());
            JsonObject turnStarted = awaitEvent(events, "turnStarted");
            String threadId = turnStarted.get("threadId").getAsString();

            JsonObject base = new JsonObject();
            base.addProperty("channelId", "native-control-test");
            base.addProperty("sessionEpoch", "test-epoch");
            base.addProperty("cwd", cwd.toString());
            base.addProperty("threadId", threadId);
            JsonArray input = new JsonArray();
            JsonObject text = new JsonObject();
            text.addProperty("type", "text");
            text.addProperty("text", "queued or steered text");
            input.add(text);

            List<NativeCommand> commands = List.of(
                    new NativeCommand("codex.steer", with(base, "input", input)),
                    new NativeCommand("codex.queueAdd", with(base, "input", input, "clientUserMessageId", "request-add-1")),
                    new NativeCommand("codex.queueList", base),
                    new NativeCommand("codex.queueUpdate", with(base, "input", input, "queuedSubmissionId", "queued-1")),
                    new NativeCommand("codex.queueDelete", with(base, "queuedSubmissionId", "queued-1")),
                    new NativeCommand("codex.queueReorder", with(base, "queuedSubmissionIds", JsonParser.parseString("[\"queued-1\"]").getAsJsonArray())),
                    new NativeCommand("codex.queueStart", base),
                    new NativeCommand("codex.fork", with(base, "lastTurnId", "turn-test-0001")));
            for (NativeCommand command : commands) {
                this.assertNativeRejection(daemon, command);
                assertFalse("native control must finish before the turn it targets", send.isDone());
            }

            List<JsonObject> wire = Files.readAllLines(trace).stream().filter(line -> !line.isBlank())
                    .map(JsonParser::parseString).map(element -> element.getAsJsonObject()).toList();
            assertTrue(wire.stream().filter(event -> "client_message".equals(event.get("kind").getAsString()))
                    .map(event -> event.get("method").getAsString()).toList().containsAll(List.of(
                            "turn/steer", "thread/queue/add", "thread/queue/list", "thread/queue/update",
                            "thread/queue/delete", "thread/queue/reorder", "thread/queue/start", "thread/fork")));

            JsonObject stop = new JsonObject();
            stop.addProperty("channelId", "native-control-test");
            stop.addProperty("sessionEpoch", "test-epoch");
            assertTrue(daemon.sendCommand("codex.abortTurn", stop, new Sink()).get(10, TimeUnit.SECONDS));
            assertFalse(send.get(10, TimeUnit.SECONDS));
        } finally {
            Process child = process.get();
            List<ProcessHandle> descendants = child == null ? List.of() : child.descendants().toList();
            daemon.stop();
            if (child != null) assertTrue(child.waitFor(10, TimeUnit.SECONDS));
            for (ProcessHandle descendant : descendants) {
                descendant.onExit().get(10, TimeUnit.SECONDS);
                assertFalse(descendant.isAlive());
            }
        }
    }

    private void exercise(String scenario, boolean disconnect) throws Exception {
        Path repository = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path home = this.folder.newFolder("home").toPath();
        Path cwd = this.folder.newFolder("workspace").toPath();
        Path trace = home.resolve("peer-trace.ndjson");
        AtomicReference<Process> process = new AtomicReference<>();
        CodexFixtureDaemon daemon = new CodexFixtureDaemon(repository, home, scenario, trace, process);
        List<JsonObject> events = new CopyOnWriteArrayList<>();
        daemon.addEventListener((kind, data) -> {
            if ("codex_event".equals(kind)) {
                events.add(data.deepCopy());
            }
        });
        try {
            assertTrue(daemon.start());
            JsonObject params = new JsonObject();
            params.addProperty("channelId", "transport-test");
            params.addProperty("sessionEpoch", "test-epoch");
            params.addProperty("cwd", cwd.toString());
            params.addProperty("message", "fixture prompt");
            params.addProperty("clientMessageId", "fixture-client-id");
            if ("native-read-only".equals(scenario)) {
                params.addProperty("threadId", "th-test-root-0001");
                Sink sink = new Sink();
                assertTrue(daemon.sendCommand("codex.readHistoryPage", params, sink).get(15, TimeUnit.SECONDS));
                String display = sink.result.get().toString();
                assertTrue(display.contains("tool_use"));
                assertTrue(display.contains("tool_result"));
                assertTrue(display.contains("thinking"));
                Sink messageCount = new Sink();
                assertTrue(daemon.sendCommand("codex.countThreadMessages", params, messageCount).get(15, TimeUnit.SECONDS));
                JsonObject countSnapshot = messageCount.result.get().getAsJsonObject("result");
                assertEquals("th-test-root-0001", countSnapshot.get("threadId").getAsString());
                assertEquals(5, countSnapshot.get("messageCount").getAsInt());
                JsonObject childParams = new JsonObject();
                childParams.addProperty("agentId", "th-test-child-0002");
                params.add("params", childParams);
                Sink childStatus = new Sink();
                assertTrue(daemon.sendCommand("codex.readSubagent", params, childStatus).get(15, TimeUnit.SECONDS));
                JsonObject childSnapshot = childStatus.result.get().getAsJsonObject("result");
                assertTrue(childSnapshot.get("completed").getAsBoolean());
                assertFalse(childSnapshot.has("messages"));
                List<JsonObject> wire = Files.readAllLines(trace).stream().map(JsonParser::parseString)
                        .map(element -> element.getAsJsonObject()).toList();
                assertFalse(wire.stream().anyMatch(event -> event.has("method") && List.of(
                        "thread/start", "thread/resume", "turn/start").contains(event.get("method").getAsString())));
                long peerPid = wire.stream().filter(event -> event.has("kind")
                        && "peer_started".equals(event.get("kind").getAsString())).findFirst().orElseThrow().get("pid").getAsLong();
                ProcessHandle nativePeer = ProcessHandle.of(peerPid).orElseThrow();
                assertTrue(nativePeer.isAlive());
                assertTrue(daemon.sendCommand("codex.releaseThread", params, new Sink()).get(15, TimeUnit.SECONDS));
                nativePeer.onExit().get(10, TimeUnit.SECONDS);
                assertFalse("release closed the native peer before daemon teardown", nativePeer.isAlive());
                return;
            }
            var send = daemon.sendCommand("codex.send", params, new Sink());
            if (disconnect) {
                var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                        () -> send.get(15, TimeUnit.SECONDS));
                assertTrue(failure.getCause().getMessage().contains("codex runtime failure"));
            } else if ("never-respond".equals(scenario)) {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (events.stream().noneMatch(event -> "turnStarted".equals(event.get("kind").getAsString()))
                        && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                JsonObject stop = new JsonObject();
                stop.addProperty("channelId", "transport-test");
                stop.addProperty("sessionEpoch", "test-epoch");
                assertTrue(daemon.sendCommand("codex.abortTurn", stop, new Sink()).get(10, TimeUnit.SECONDS));
                assertFalse(send.get(10, TimeUnit.SECONDS));
            } else {
                JsonObject request = null;
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (request == null && System.nanoTime() < deadline) {
                    request = events.stream().filter(event -> "interactionRequested".equals(
                            event.get("kind").getAsString())).findFirst().orElse(null);
                    if (request == null) {
                        Thread.sleep(20);
                    }
                }
                assertTrue("approval arrived through the production daemon listener", request != null);
                assertFalse("send still owns its FIFO slot", send.isDone());
                JsonObject response = new JsonObject();
                response.addProperty("channelId", "transport-test");
                response.addProperty("sessionEpoch", "test-epoch");
                response.add("rpcId", request.getAsJsonObject("payload").get("rpcId"));
                JsonObject result = new JsonObject();
                result.addProperty("decision", "accept");
                response.add("result", result);
                assertTrue(daemon.sendCommand("codex.respondInteraction", response, new Sink()).get(10, TimeUnit.SECONDS));
                assertTrue(send.get(10, TimeUnit.SECONDS));
                assertTrue(Files.readAllLines(trace).stream().map(JsonParser::parseString)
                        .map(element -> element.getAsJsonObject()).anyMatch(event -> event.has("kind")
                                && "server_response".equals(event.get("kind").getAsString())));
            }
        } finally {
            Process child = process.get();
            List<ProcessHandle> descendants = child == null ? List.of() : child.descendants().toList();
            daemon.stop();
            if (child != null) {
                assertTrue(child.waitFor(10, TimeUnit.SECONDS));
            }
            for (ProcessHandle descendant : descendants) {
                descendant.onExit().get(10, TimeUnit.SECONDS);
                assertFalse("native peer was reaped", descendant.isAlive());
            }
        }
    }

    private void assertNativeRejection(CodexFixtureDaemon daemon, NativeCommand command) throws Exception {
        Sink sink = new Sink();
        var future = daemon.sendCommand(command.method(), command.params(), sink);
        assertThrows(java.util.concurrent.ExecutionException.class, () -> future.get(10, TimeUnit.SECONDS));
        JsonObject response = sink.result.get();
        assertTrue(command.method() + " returns a structured response", response != null);
        assertEquals(command.method(), false, response.get("success").getAsBoolean());
        assertEquals("UNSUPPORTED", response.get("code").getAsString());
        assertTrue(response.get("error").getAsString().contains("does not support"));
    }

    private static JsonObject awaitEvent(List<JsonObject> events, String kind) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            JsonObject found = events.stream().filter(event -> kind.equals(event.get("kind").getAsString()))
                    .findFirst().orElse(null);
            if (found != null) return found;
            Thread.sleep(20);
        }
        throw new AssertionError("missing Codex event: " + kind);
    }

    private static JsonObject with(JsonObject source, String name, JsonArray value) {
        JsonObject copy = source.deepCopy();
        copy.add(name, value.deepCopy());
        return copy;
    }

    private static JsonObject with(JsonObject source, String name, JsonArray value, String secondName, String secondValue) {
        JsonObject copy = with(source, name, value);
        copy.addProperty(secondName, secondValue);
        return copy;
    }

    private static JsonObject with(JsonObject source, String name, String value) {
        JsonObject copy = source.deepCopy();
        copy.addProperty(name, value);
        return copy;
    }

    private record NativeCommand(String method, JsonObject params) { }

    private static final class Sink implements DaemonBridge.DaemonOutputCallback {
        private final AtomicReference<JsonObject> result = new AtomicReference<>();

        @Override
        public void onResult(JsonObject response) {
            this.result.set(response);
        }
        @Override
        public void onLine(String line) { }

        @Override
        public void onStderr(String text) { }

        @Override
        public void onError(String error) { }

        @Override
        public void onComplete(boolean success) { }
    }
}
