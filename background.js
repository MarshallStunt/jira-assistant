// Make every request the extension sends (Jira, NetBox, the AI APIs, local models) look like a
// plain API client instead of a browser: drop the Origin/Referer/Sec-* headers Chrome adds and
// replace the browser User-Agent.
const PLAIN_CLIENT_RULE_ID = 1;
const BROWSER_HEADERS = ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"];

async function installPlainClientRule() {
  const rule = (headers) => ({
    id: PLAIN_CLIENT_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        ...headers.map((header) => ({ header, operation: "remove" })),
        { header: "user-agent", operation: "set", value: `jira-assistant/${chrome.runtime.getManifest().version}` }
      ]
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ["xmlhttprequest", "other"]
    }
  });
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PLAIN_CLIENT_RULE_ID], addRules: [rule(BROWSER_HEADERS)] });
  } catch (e) {
    // Some Chrome versions refuse to touch Sec-* headers; Origin and User-Agent are the ones that matter.
    console.warn("plain client rule", e);
    await chrome.declarativeNetRequest
      .updateDynamicRules({ removeRuleIds: [PLAIN_CLIENT_RULE_ID], addRules: [rule(["origin", "referer"])] })
      .catch((e2) => console.warn("plain client rule", e2));
  }
}
installPlainClientRule();

// Clicking the toolbar icon opens the side panel.
function enablePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

chrome.runtime.onInstalled.addListener((details) => {
  enablePanel();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  // Slack direct-message lookup was removed in 1.7.2: forget its saved token, address and member list.
  chrome.storage.local.remove(["slackToken", "slackUrl", "slackDir"]);
});

chrome.runtime.onStartup.addListener(enablePanel);
