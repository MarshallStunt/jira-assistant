// Open a Slack direct message with someone from the ticket, using Slack in Chrome (no token):
// the extension drives your own Slack tab the way you would: ⌘K / Ctrl+K, type the name, pick the person.
// Nothing is read from Slack and no message is sent; the cursor ends up in the message box.

// Runs inside the Slack tab (injected with chrome.scripting), so it must be self-contained.
async function slackOpenDmInPage(name, isMac) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  };
  const key = (opts, target = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts }));
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

  if (!(await waitFor(() => document.querySelector('[data-qa="top_nav_search"]'), 20000))) {
    return { ok: false, why: "Slack didn't finish loading" };
  }
  const searchBox = () => [...document.querySelectorAll('[data-qa="search_input_box"] [contenteditable="true"]')].find((e) => e.offsetParent);
  if (searchBox()) {
    searchBox().focus(); // search already open: ⌘K would close it
  } else {
    // ⌘K inside a message box means "add link", so leave any text box first.
    document.activeElement?.blur?.();
    key({ key: "k", code: "KeyK", keyCode: 75, which: 75, metaKey: isMac, ctrlKey: !isMac });
  }
  const box = await waitFor(() => {
    const a = document.activeElement;
    return a?.isContentEditable && a.closest('[data-qa="search_input_box"]') ? a : null;
  }, 3000);
  if (!box) return { ok: false, why: "couldn't open Slack's search" };

  // Never type unless the cursor is really in Slack's search box (not a message box).
  if (document.activeElement !== box || !box.closest('[data-qa="search_input_box"]')) return { ok: false, why: "search box lost focus" };
  // Empty the box first: Slack keeps the last search, and its old suggestions would be clicked by mistake.
  document.execCommand("selectAll");
  document.execCommand("delete");
  await sleep(300);
  document.execCommand("insertText", false, name);
  await sleep(700); // let Slack refresh the suggestions for the new text

  // The person suggestion (not "Show results for: …"); matching the first name allows "Jane M. Doe" vs "Jane Doe".
  const first = norm(name).split(" ")[0];
  const findPerson = () => [...document.querySelectorAll('[role="option"][id^="c-search_autocomplete__suggestion_"]')]
    .find((o) => !/^show results for/i.test(o.innerText.trim()) && norm(o.innerText).includes(first));
  // Success only when the message box is addressed to that person ("Message to Jane Doe").
  const chatOpen = () => [...document.querySelectorAll('[data-qa="message_input"] [contenteditable="true"]')]
    .find((c) => norm(c.getAttribute("aria-label") || "").includes(first));

  for (let attempt = 0; attempt < 2; attempt++) {
    const person = await waitFor(findPerson, 5000);
    if (!person) break;
    person.click();
    const composer = await waitFor(chatOpen, 2500);
    if (composer) {
      composer.focus();
      return { ok: true };
    }
  }
  // Close the search again so Slack is left as it was.
  const open = searchBox();
  if (open) key({ key: "Escape", code: "Escape", keyCode: 27, which: 27 }, open);
  return { ok: false, why: "not found in Slack" };
}

// Find (or open) Slack in Chrome and open the DM there. Returns { ok, why }.
async function openSlackDm(name, { openIfMissing }) {
  let [tab] = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  if (!tab) {
    if (!openIfMissing) return { ok: false, why: "no Slack tab" };
    tab = await chrome.tabs.create({ url: "https://app.slack.com/client" });
    for (let i = 0; i < 60 && tab.status !== "complete"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      tab = await chrome.tabs.get(tab.id);
    }
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: slackOpenDmInPage, args: [name, IS_MAC] });
    return result || { ok: false, why: "Slack didn't respond" };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}
