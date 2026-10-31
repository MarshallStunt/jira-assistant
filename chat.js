// "Ask the AI" box: follow-up questions about the open ticket.
// The AI gets the ticket data + the brief as context. History is kept per ticket for the browser session.

const CHAT_SUGGESTIONS = [
  "What should I check first?",
  "Explain the error in simple terms",
  "Draft a reply to the requester"
];
const MAX_TURNS = 20; // keep the last N messages as context

const chat = { key: null, history: [], busy: false, getContext: null };

function chatSystemPrompt(settings, key, issueText, brief, netbox, bmc) {
  let p = `You are an assistant for Datacenter Operations technicians at Lambda, a GPU cloud company. The technician is working on Jira ticket ${key} and asks follow-up questions about it.

Answer concisely and practically, like a senior DC technician would: short sentences, short lists, concrete commands or steps when useful. Use plain text (no markdown tables or headings). If something isn't in the ticket, say so instead of guessing. Never say it is OK to power down a server unless the ticket explicitly allows it. If asked to draft a message or comment, write it ready to paste.`;
  if (settings.teamContext?.trim()) p += `\n\nTeam procedures and conventions:\n${settings.teamContext.trim()}`;
  if (settings.customInstructions?.trim()) p += `\n\nAdditional instructions from the user:\n${settings.customInstructions.trim()}`;
  p += `\n\n=== Ticket ${key} ===\n${String(issueText || "(ticket text unavailable)").slice(0, 60000)}`;
  if (brief) p += `\n\n=== Brief already shown to the technician ===\n${JSON.stringify(brief)}`;
  if (netbox?.ok) p += `\n\n=== NetBox record(s) for this server (source of truth for location, IPs, cabling) ===\n${JSON.stringify(netbox.devices).slice(0, 20000)}`;
  const health = Object.values(bmc || {}).filter((x) => x?.ok).map(({ ip, system, manager, problems, events, at }) => ({ ip, system, manager, problems, events, readAt: new Date(at).toISOString() }));
  if (health.length) p += `\n\n=== Live BMC health read over Redfish (actual power state, failed parts, event log) ===\n${JSON.stringify(health).slice(0, 15000)}`;
  return p;
}

// Light clean-up of markdown the model may still use.
function tidyAnswer(t) {
  return t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[*]\s+/gm, "• ").trim();
}

function renderChat() {
  const log = $("chatLog");
  log.innerHTML = "";
  for (const m of chat.history) {
    const bubble = h("div", { class: `msg ${m.role}${m.error ? " error" : ""}` }, h("div", { class: "msg-text" }, m.content));
    if (m.role === "assistant" && !m.error) {
      const copy = h("button", { class: "msg-copy", title: "Copy answer" }, "Copy");
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(m.content);
        copy.textContent = "Copied ✓";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      bubble.appendChild(copy);
    }
    log.appendChild(bubble);
  }
  if (chat.busy) log.appendChild(h("div", { class: "msg assistant thinking" }, h("span", { class: "spinner" }), "Thinking…"));

  const sug = $("chatSuggest");
  sug.innerHTML = "";
  if (!chat.history.length && !chat.busy) {
    CHAT_SUGGESTIONS.forEach((q) => sug.appendChild(h("button", { class: "chip suggest", onclick: () => askAI(q) }, q)));
  }
  $("chatClear").classList.toggle("hidden", !chat.history.length || chat.busy);
  $("chatSend").disabled = chat.busy;
  $("chatInput").disabled = chat.busy;
}

async function saveChat() {
  await chrome.storage.session.set({ [`chat:${chat.key}`]: chat.history });
}

// Called whenever a brief is shown. getContext() → { issueText, brief }
async function openChat(key, getContext) {
  chat.key = key;
  chat.getContext = getContext;
  chat.busy = false;
  chat.history = (await chrome.storage.session.get(`chat:${key}`))[`chat:${key}`] || [];
  $("chat").classList.remove("hidden");
  renderChat();
}

function closeChat() {
  chat.key = null;
  $("chat").classList.add("hidden");
}

async function askAI(question) {
  question = (question || "").trim();
  if (!question || chat.busy || !chat.key) return;
  const key = chat.key;
  chat.history.push({ role: "user", content: question });
  chat.busy = true;
  $("chatInput").value = "";
  autoGrow();
  renderChat();
  scrollChatIntoView();

  try {
    const settings = await getSettings();
    const problem = missingConfig(settings);
    if (problem) throw new Error(problem);
    const { issueText, brief, netbox, bmc, people } = await chat.getContext();
    const privacy = makeRedactor(settings, people); // same placeholders for the ticket and the questions
    const messages = chat.history.filter((m) => !m.error).slice(-MAX_TURNS).map(({ role, content }) => ({ role, content: privacy.redact(content) }));
    const { text } = await generateText(settings, {
      system: privacy.redact(chatSystemPrompt(settings, key, issueText, brief, netbox, bmc)),
      messages
    });
    if (chat.key !== key) return; // user switched tickets meanwhile
    chat.history.push({ role: "assistant", content: tidyAnswer(privacy.restore(text)) });
  } catch (e) {
    if (chat.key !== key) return;
    chat.history.push({ role: "assistant", content: String(e.message || e), error: true });
  } finally {
    if (chat.key === key) {
      chat.busy = false;
      await saveChat();
      renderChat();
      scrollChatIntoView();
      $("chatInput").focus();
    }
  }
}

function scrollChatIntoView() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function autoGrow() {
  const el = $("chatInput");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  askAI($("chatInput").value);
});
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    askAI($("chatInput").value);
  }
});
$("chatInput").addEventListener("input", autoGrow);
$("chatClear").addEventListener("click", async () => {
  chat.history = [];
  await saveChat();
  renderChat();
});
