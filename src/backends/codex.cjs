"use strict";

const { spawn } = require("node:child_process");
const { readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { createReplyReader, listThreads, readThread, readThreadCwd } = require("./codex-history.cjs");

const retryableLaunchErrors = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "EAGAIN",
  "ENOMEM",
  "EMFILE",
  "ENFILE",
]);
const invalidArguments = new Set([
  "E2BIG",
  "ENAMETOOLONG",
  "ERR_INVALID_ARG_VALUE",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Desktop session handles and permission selectors belong to the owner session.
const desktopKeys = new Set([
  "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_PERMISSION_PROFILE", "CODEX_SESSION_ID", "CODEX_THREAD_ID",
  "CODEX_WINDOWS_REGISTERED_CORE", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
]);

function childEnvironment(external = false) {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== "WECOM_BOT_SECRET" && !(external && desktopKeys.has(key.toUpperCase())),
    ),
  );
}

function requestDesktopWake(threadId) {
  return new Promise((resolve, reject) => {
    const uri = "codex://threads/wake/" + threadId;
    let executable =
      process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
    let args = [uri];
    if (process.platform === "win32") {
      executable = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const command =
        "Start-Process -FilePath ('codex://threads/wake/' + $env:CODEX_BRIDGE_WAKE_UUID) -WindowStyle Hidden -ErrorAction Stop";
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
    }
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      timeout: 15_000,
      env: { ...childEnvironment(), CODEX_BRIDGE_WAKE_UUID: threadId },
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Protocol handler request failed"));
    });
  });
}

function launchFailure(child, error) {
  if (!child?.pid && retryableLaunchErrors.has(error.code))
    return { state: "queued", reason: error.code };
  if (!child?.pid && invalidArguments.has(error.code))
    return { state: "rejected", reason: error.code };
  return { state: "uncertain", reason: "cli_outcome_unknown" };
}

function queueInCodex(execute, codexPath, threadId, prompt, options) {
  return new Promise((resolve) => {
    let child,
      launchError,
      queueId,
      warning = false;
    try {
      child = execute(
        codexPath,
        ["queue", "--thread", threadId, "--message", prompt, "--resume"],
        options,
      );
    } catch (error) {
      return resolve(launchFailure(child, error));
    }
    child.on("error", (error) => {
      launchError = error;
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
    for (const stream of [child.stderr, child.stdout]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on(
        "line",
        (line) => {
          const receipt = /^Queued message (\S+) for thread (\S+)\.?$/i.exec(
            line.trim(),
          );
          if (
            receipt &&
            uuid.test(receipt[1]) &&
            receipt[2].replace(/\.$/, "") === threadId
          )
            queueId = receipt[1];
          if (
            /\bwarn(?:ing)?\b|(?:could not|unable to|failed to) resume/i.test(
              line,
            )
          )
            warning = true;
        },
      );
    }
    child.once("close", (code) => {
      if (launchError) return resolve(launchFailure(child, launchError));
      if (code !== 0)
        return resolve({ state: "uncertain", reason: "queue_outcome_unknown" });
      resolve({
        state: "accepted",
        queueId,
        ...(warning && { wakeConfirmed: false }),
      });
    });
  });
}

function externalArgs(workingDir) {
  const args = ["-a", "never",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "sandbox_workspace_write.writable_roots=[]",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c", "mcp_servers={}",
    "-c", "features.skip_host_skill_discovery=true",
    "-c", "projects." + JSON.stringify(workingDir) + '.trust_level="untrusted"',
  ];
  for (const feature of ["apps", "plugins", "hooks", "browser_use", "computer_use",
    "multi_agent", "multi_agent_v2", "request_permissions_tool", "skill_mcp_dependency_install"]) {
    args.push("--disable", feature);
  }
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="elevated"');
  return [...args, "exec", "--sandbox", "workspace-write", "--ephemeral",
    "--ignore-user-config", "--ignore-rules", "-C", workingDir];
}

function runTurn(execute, codexPath, { workingDir, threadId, prompt, onStarted, onCreated, autoCreated }, outputFile, external) {
  const args = external ? externalArgs(workingDir) : ["exec", "-c", "sandbox_workspace_write.network_access=true", "-C", workingDir];
  if (threadId) args.push("resume");
  args.push("--json");
  if (!threadId || autoCreated) args.push("--skip-git-repo-check");
  if (outputFile) args.push("--output-last-message", outputFile);
  if (threadId) args.push(threadId);
  args.push("-");
  const options = {
    shell: false,
    windowsHide: true,
    env: childEnvironment(external),
    ...(external && { cwd: workingDir }),
    stdio: ["pipe", "pipe", "pipe"],
  };
  return new Promise((resolve) => {
    let child,
      launchError,
      inputFailed = false;
    let activeWriter = false,
      sawEvent = false;
    let matched = false,
      wrongThread = false,
      started = false,
      replied = false,
      completed = false,
      failed = false;
    try {
      child = execute(codexPath, args, options);
    } catch (error) {
      return resolve(launchFailure(child, error));
    }
    child.on("error", (error) => {
      launchError = error;
    });
    child.stdin.on("error", () => {
      inputFailed = true;
    });
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        const match =
          /\bthread\/resume failed:\s*thread\s+["'`]?([\w-]+)["'`]?\s+already has an active writer\b/i.exec(
            line,
          );
        if (threadId && match?.[1] === threadId) activeWriter = true;
      },
    );
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        sawEvent = true;
        if (event.type === "thread.started") {
          if (!threadId && uuid.test(event.thread_id)) {
            threadId = event.thread_id;
            try {
              if (!external) onCreated(threadId);
            } catch {
              wrongThread = true;
              child.kill();
            }
          }
          matched = !!threadId && event.thread_id === threadId;
          if (!matched) {
            wrongThread = true;
            child.kill();
          }
        }
        if (!matched || wrongThread) return;
        if (event.type === "turn.started" && !started) {
          started = true;
          onStarted();
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          typeof event.item.text === "string" &&
          event.item.text.trim()
        )
          replied = true;
        if (event.type === "turn.completed") completed = replied;
        if (event.type === "turn.failed") failed = true;
      },
    );
    child.once("close", (code) => {
      if (launchError) return resolve(launchFailure(child, launchError));
      if (!external && code === 1 && activeWriter && !sawEvent && !inputFailed) {
        return resolve(
          queueInCodex(execute, codexPath, threadId, prompt, options),
        );
      }
      if (
        code === 0 &&
        matched &&
        completed &&
        !wrongThread &&
        !failed &&
        !inputFailed
      ) {
        return resolve({ state: "completed" });
      }
      const reason = wrongThread
        ? "unexpected_thread"
        : failed
          ? "turn_failed"
          : "turn_outcome_unknown";
      resolve({ state: "uncertain", reason });
    });
    child.stdin.end(prompt, "utf8");
  });
}

function parseThreadId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  // Codex may copy the chat title and URL together as a Markdown link.
  const markdownLink = /^\[(?:[^\]\\\r\n]|\\.)*\]\((codex:\/\/threads\/[^()\s]+)\)$/i.exec(text);
  const id = (markdownLink?.[1] ?? text).replace(/^codex:\/\/threads\//i, '');
  if (!uuid.test(id)) throw new Error('.config.local.json 中的 threadId 需要填写聊天 UUID 或复制的 Codex 聊天深度链接。');
  return id.toLowerCase();
}

function createCodexBackend({ codexPath, execute = spawn, wakeDesktop = requestDesktopWake }) {
  if (typeof codexPath !== "string" || !codexPath.trim()) throw new Error("Missing Codex executable");
  async function submitTurn(turn, external) {
    const outputFile = turn.replyToken && join(turn.stateDir, turn.replyToken + ".final.tmp");
    try {
      const result = await runTurn(execute, codexPath, turn, outputFile, external);
      if (outputFile && result.state === "completed") {
        try { result.text = readFileSync(outputFile, "utf8"); }
        catch { /* A missing final cannot be sent back to the chat. */ }
      }
      return result;
    } finally {
      if (outputFile) rmSync(outputFile, { force: true });
    }
  }
  return {
    id: "codex",
    name: "Codex",
    missingReceiptReason: "missing_codex_receipt",
    eventMessages: {
      delivery_queued_in_codex: "消息已进入目标 Codex 聊天的队列。",
      desktop_wake_requested: "已请求 Codex 桌面版唤醒目标聊天。",
      desktop_wake_failed: "唤醒请求失败，消息已在 Codex 队列中。",
    },
    parseThreadId,
    getThreadTitle: async threadId => (await readThread({ codexPath, threadId, timeoutMs: 800 })).name,
    getWorkingDir: threadId => readThreadCwd({ codexPath, threadId }),
    listThreads: workingDir => listThreads({ codexPath, workingDir }),
    readReplies: (target, keys) => createReplyReader({ codexPath, ...target })(keys),
    replyKey: queueId => "client:" + queueId,
    acceptedEvent: "delivery_queued_in_codex",
    submit: turn => submitTurn(turn, false),
    submitExternal: turn => submitTurn({ ...turn, threadId: undefined }, true),
    async afterAccepted(result, threadId, log) {
      if (result.wakeConfirmed !== false) return;
      if (threadId.length !== 36 || !uuid.test(threadId)) {
        log("desktop_wake_failed", { reason: "invalid_thread_uuid" });
        return;
      }
      try {
        await wakeDesktop(threadId);
        log("desktop_wake_requested");
      } catch {
        log("desktop_wake_failed", { reason: "protocol_request_failed" });
      }
    },
  };
}

module.exports = { createCodexBackend, parseThreadId };
