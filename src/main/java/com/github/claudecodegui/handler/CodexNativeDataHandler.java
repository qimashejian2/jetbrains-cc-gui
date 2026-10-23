package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** Routes native Codex history and catalog reads through app-server. */
public class CodexNativeDataHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexNativeDataHandler.class);
    private static final Gson GSON = new Gson();
    private static final Set<String> INTERACTION_ACTIONS = Set.of("steer", "fork");
    private static final Map<String, String> METHODS = Map.of(
            "codex_native_list_threads", "codex.listThreads",
            "codex_native_list_threads_page", "codex.listThreads",
            "codex_native_count_thread_messages", "codex.countThreadMessages",
            "codex_native_read_thread", "codex.readThread",
            "codex_native_list_models", "codex.listModels",
            "codex_native_list_skills", "codex.listSkills",
            "codex_native_mcp_status", "codex.getMcpStatus",
            "codex_native_mcp_reload", "codex.reloadMcp"
    );

    /** Creates a native data handler for one chat window. */
    public CodexNativeDataHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        String[] supported = new String[METHODS.size() + 1];
        int index = 0;
        for (String type : METHODS.keySet()) {
            supported[index++] = type;
        }
        supported[index] = "codex_queue_action";
        return supported;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("codex_queue_action".equals(type)) {
            return handleQueueAction(content);
        }
        String method = METHODS.get(type);
        if (method == null) {
            return false;
        }
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        String threadId = nonEmpty(stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        JsonObject params = payload != null && payload.has("params") && payload.get("params").isJsonObject()
                ? payload.getAsJsonObject("params") : payload == null ? new JsonObject() : payload.deepCopy();
        if (payload != null) {
            params.remove("channelId");
            params.remove("cwd");
            params.remove("threadId");
            params.remove("append");
            params.remove("requestId");
        }
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            JsonObject failure = error("Codex bridge is unavailable");
            if (payload != null && payload.has("requestId")) {
                failure.add("requestId", payload.get("requestId").deepCopy());
            }
            this.publish(type, failure);
            return true;
        }
        String expectedEpoch = bridge.captureRuntimeSessionEpoch(channelId);
        if (expectedEpoch == null) {
            JsonObject failure = error("Codex session changed before native request", "STALE_SESSION");
            if (payload != null && payload.has("requestId")) {
                failure.add("requestId", payload.get("requestId").deepCopy());
            }
            failure.addProperty("cwd", cwd);
            this.publish(type, failure);
            return true;
        }
        CompletableFuture<JsonObject> result = bridge.readCodexNative(
                method, channelId, cwd, threadId, params, expectedEpoch);
        result.whenComplete((response, failure) -> {
            JsonObject output = response == null ? new JsonObject() : response.deepCopy();
            if (payload != null && payload.has("requestId")) {
                output.add("requestId", payload.get("requestId").deepCopy());
            }
            output.addProperty("cwd", cwd);
            if (failure != null) {
                output.addProperty("error", failure.getMessage() == null
                        ? "Native Codex request failed" : failure.getMessage());
            }
            publish(type, output);
        });
        return true;
    }

    private boolean handleQueueAction(String content) {
        JsonObject payload = parseObject(content);
        if (payload == null) {
            publishQueueResult(null, error("Invalid Codex queue request", "INVALID_PARAMS"), null);
            return true;
        }
        String action = stringValue(payload, "action");
        if (action != null && INTERACTION_ACTIONS.contains(action)) {
            return false;
        }
        JsonElement requestId = payload.get("requestId");
        if (!hasStableRequestId(requestId)) {
            publishQueueResult(requestId, error("Codex queue action requires a stable requestId", "INVALID_PARAMS"), null);
            return true;
        }
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        String threadId = nonEmpty(stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        if (session != null && !java.util.Objects.equals(threadId, session.getSessionId())) {
            publishQueueResult(requestId, error("Requested Codex thread is no longer selected", "STALE_SESSION"), null);
            return true;
        }
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            publishQueueResult(requestId, error("Codex bridge is unavailable", "BRIDGE_UNAVAILABLE"), null);
            return true;
        }
        String expectedEpoch = bridge.captureRuntimeSessionEpoch(channelId);
        if (expectedEpoch == null) {
            publishQueueResult(requestId, error("Codex session changed before queue action", "STALE_SESSION"), null);
            return true;
        }
        JsonObject actionParams = payload.has("params") && payload.get("params").isJsonObject()
                ? payload.getAsJsonObject("params").deepCopy() : payload.deepCopy();
        for (String key : new String[]{"action", "requestId", "channelId", "cwd", "threadId", "turnId"}) {
            if (!payload.has("params") || !payload.get("params").isJsonObject()) {
                actionParams.remove(key);
            }
        }
        if ("add".equals(action)) {
            String clientUserMessageId = requestId.getAsString();
            if (clientUserMessageId == null || clientUserMessageId.isBlank()) {
                publishQueueResult(requestId, error("Queue add requires a stable requestId", "INVALID_PARAMS"), null);
                return true;
            }
            actionParams.addProperty("clientUserMessageId", clientUserMessageId);
        }

        CompletableFuture<JsonObject> request = CompletableFuture
                .supplyAsync(() -> queueAction(bridge, action, channelId, cwd, threadId, actionParams, expectedEpoch),
                        CodexSDKBridge.codexControlExecutor())
                .thenCompose(future -> future);
        request.whenComplete((result, failure) -> publishQueueResult(requestId, result, failure));
        return true;
    }

    private CompletableFuture<JsonObject> queueAction(
            CodexSDKBridge bridge, String action, String channelId, String cwd, String threadId,
            JsonObject params, String expectedEpoch) {
        return switch (action == null ? "" : action) {
            case "list" -> bridge.listCodexQueue(channelId, cwd, threadId, expectedEpoch);
            case "add" -> bridge.queueCodexMessage(channelId, cwd, threadId,
                    params.has("input") && params.get("input").isJsonArray()
                            ? params.getAsJsonArray("input") : null,
                    stringValue(params, "clientUserMessageId"), expectedEpoch);
            case "update", "delete", "reorder" ->
                    bridge.mutateCodexQueue(action, channelId, cwd, threadId, params, expectedEpoch);
            case "start" -> bridge.startCodexQueue(
                    channelId, cwd, threadId, stringValue(params, "queuedSubmissionId"), expectedEpoch);
            default -> CompletableFuture.completedFuture(error("Unsupported Codex queue action: " + action,
                    "INVALID_ACTION"));
        };
    }

    private void publishQueueResult(JsonElement requestId, JsonObject response, Throwable failure) {
        JsonObject event = new JsonObject();
        event.add("requestId", requestId == null ? JsonNull.INSTANCE : requestId.deepCopy());
        if (failure != null) {
            Throwable cause = unwrap(failure);
            event.addProperty("error", cause.getMessage() == null ? "Codex queue request failed" : cause.getMessage());
            event.addProperty("code", "DAEMON_ERROR");
            event.addProperty("success", false);
        } else if (response == null) {
            event.addProperty("error", "Codex queue request returned no result");
            event.addProperty("code", "DAEMON_ERROR");
            event.addProperty("success", false);
        } else {
            if (response.has("result")) {
                event.add("result", response.get("result").deepCopy());
            }
            if (response.has("error")) {
                event.add("error", response.get("error").deepCopy());
            }
            if (response.has("code")) {
                event.add("code", response.get("code").deepCopy());
            }
            event.addProperty("success", !response.has("success") || response.get("success").getAsBoolean());
            if (!event.has("result") && !event.has("error")) {
                event.add("result", response.deepCopy());
            }
        }
        String json = GSON.toJson(event);
        executeJavaScript("window.dispatchEvent(new CustomEvent('codex-queue-result', {detail: JSON.parse('"
                + escapeJs(json) + "')}));");
    }

    private static Throwable unwrap(Throwable failure) {
        Throwable cause = failure;
        while (cause instanceof CompletionException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause;
    }

    private static JsonObject error(String message, String code) {
        JsonObject result = new JsonObject();
        result.addProperty("error", message);
        result.addProperty("code", code);
        result.addProperty("success", false);
        return result;
    }

    private static boolean hasStableRequestId(JsonElement requestId) {
        return requestId != null && requestId.isJsonPrimitive()
                && requestId.getAsJsonPrimitive().isString() && !requestId.getAsString().isBlank();
    }

    private void publish(String requestType, JsonObject response) {
        JsonObject envelope = response == null ? new JsonObject() : response.deepCopy();
        envelope.addProperty("requestType", requestType);
        envelope.addProperty("source", "native");
        callJavaScript("onCodexNativeData", escapeJs(GSON.toJson(envelope)));
    }

    private static JsonObject parseObject(String content) {
        try {
            return content == null || content.trim().isEmpty()
                    ? new JsonObject() : GSON.fromJson(content, JsonObject.class);
        } catch (Exception exception) {
            LOG.debug("[CodexNativeData] Invalid request: " + exception.getMessage());
            return null;
        }
    }

    private static String stringValue(JsonObject object, String name) {
        return object != null && object.has(name) && !object.get(name).isJsonNull()
                ? object.get(name).getAsString() : null;
    }

    private static String nonEmpty(String preferred, String fallback) {
        return preferred == null || preferred.trim().isEmpty() ? fallback : preferred;
    }

    private static JsonObject error(String message) {
        JsonObject result = new JsonObject();
        result.addProperty("error", message);
        return result;
    }
}
