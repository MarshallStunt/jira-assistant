# DC Ops Jira Assistant (Chrome extension)

A side panel for Datacenter Operations. Open a Jira ticket and you get a one-glance work brief:

1. **Power-down verdict**, color-coded: ✅ OK to power down · ℹ️ No power-down needed · ⚠️ Confirm before powering down · ⛔ Do NOT power down. Each verdict includes the reason and who approved it. If there is no explicit approval in the ticket, it never says "OK" and shows "Confirm" instead.
2. **Server & location**: hostname chips (click to copy) and an **Open BMC ↗** button for each BMC IP in the ticket, which opens the BMC web login in a new tab. The site is shown on its own line (code + full name, e.g. **ORD01**, Elk Grove Village, IL (EdgeConnex CHI02)), with Row / Rack / RU below.
   **Reachability**: pings the server's **IP addresses** from the ticket (host, BMC/IPMI, mgmt, data). Hostnames and serial numbers are not pinged. If the AI labels no IPs, it pings any IPv4 addresses it finds in the ticket text. For each one it shows up/down, latency, packet loss, and which of *your* interfaces the traffic goes out on (Wi-Fi, Ethernet or VPN), e.g. `via utun4 (VPN)`.
   **NetBox**: looks the server up in NetBox (by hostname, or serial if no hostname) and shows status, model, site/rack/RU, serial, asset tag, tenant/cluster, host IP, **BMC IP with Open BMC**, and interfaces & cabling (which switch/port each port goes to). If the ticket and NetBox disagree (rack, RU, site or serial), you get a ⚠ warning. NetBox's host and BMC IPs are also pinged.
   **Podcrawler**: shows the last Podcrawler activity from the device's NetBox journal. **Open ↗** opens Podcrawler and copies the hostname so you can paste it into the search. For replacement or swap tickets, a "Rescan the server in Podcrawler" step is added to the checklist automatically.
3. **Request**: what you're being asked to do, and where it stands now.
4. **Cautions**: live neighbours, ESD, RMA deadlines, etc.
5. **Next steps checklist**: tick steps off as you go. Risky steps are shown in red.
6. **Parts & tools** needed.
7. **History**: a timeline summarizing previous comments, work logs, status changes and requests.
8. **To confirm & probable cause** (collapsible).
9. **Ask the AI**: a chat box at the bottom for follow-up questions or requests about the open ticket (e.g. "what does Xid 79 mean?", "draft a reply to the requester"). The AI sees the ticket and the brief. Each ticket keeps its own conversation until the browser restarts; **Clear** starts over.

Use **Copy as Jira comment** to paste the brief into the ticket.

It works with the AI provider you choose:

| Provider | What you need |
|---|---|
| Anthropic (Claude) | API key from console.anthropic.com |
| OpenAI | API key from platform.openai.com |
| Google Gemini | API key from aistudio.google.com |
| Local – LM Studio | LM Studio server running (Developer tab → Start server, default `http://localhost:1234/v1`) |
| Local – Ollama | `ollama serve` running (default `http://localhost:11434/v1`). If you get a 403, set `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama. |

## Install
1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `jira-assistant` folder.
3. The settings page opens. Pick a provider, enter its key (or local server URL), click **Load models** to test the connection, choose a model, then **Save**.
   If you're updating from v1.0, click the **reload** icon on the extension card instead. Your Anthropic key carries over.
4. Pin the extension and click its icon to open the side panel.

## Use
- Open any issue (`/browse/ABC-123` or a board with `selectedIssue=ABC-123`). With auto-analyze on, results appear automatically. Otherwise click **Analyze**.
- **Re-analyze** forces a fresh run, e.g. after new comments. Results and checklist ticks are kept per issue until the browser restarts.
- Put your team's procedures in **Settings → Team context** (hostname format, which parts are hot-swappable, who approves power-downs). The AI follows them.
- Add your own extra rules in **Settings → AI instructions → Custom instructions** (e.g. "max 5 next steps", "always mention the RMA number"). They're added to every prompt and take priority. The power-down evidence check always stays on.
- **Copy as Jira comment** copies the result in Jira wiki format.

## Ping helper (one-time setup)
Browsers can't send pings, so a small Python helper on your computer does it, via Chrome's native messaging.
1. Open the extension's **Settings → Ping & reachability** and click **Copy** next to the install command. It contains your extension's ID.
2. Paste it into **Terminal** and press Enter. It looks like: `bash ~/Desktop/jira-assistant/ping-helper/install.sh <extension-id>`
3. Click **Test ping helper**. You should see ✓.

Notes:
- The helper is copied to `~/Library/Application Support/DCOpsPingHelper` and registered for Chrome, Edge, Brave and Chromium (whichever you have).
- It only accepts IP addresses/hostnames and runs `ping` / `route get` without a shell. It can't run anything else.
- It needs python3. On macOS, if it's missing, run `xcode-select --install`.
- Pings run from *your* computer, so results depend on your network/VPN. "via Wi-Fi" while the server is on a private DC network usually means your VPN isn't connected.
- To remove it: `bash ~/Desktop/jira-assistant/ping-helper/uninstall.sh`
- **BMC web address** (Settings): the Open BMC button uses `https://{ip}` by default. Change it if your BMCs use http or a port, e.g. `http://{ip}:8080`. Expect a certificate warning on BMCs with self-signed certs.

## NetBox & Podcrawler setup
- Nothing to set up if you're logged in to NetBox (`netbox.prod.lambdalabs.cloud`) in Chrome: the extension uses that login. Use **Settings → Test NetBox** to check.
- If it says you're not logged in even though you are, create a read-only API token in NetBox (your profile → API Tokens) and paste it in **Settings → NetBox API token**.
- NetBox data is read-only: the extension never changes anything in NetBox.

## How it works
- Reads the issue through Jira's REST API (`/rest/api/2/issue/KEY`) inside the Jira tab, using your existing login. No Jira token is needed. If the API is blocked, it falls back to the visible page text.
- Sends the issue fields, the latest 40 comments, work logs and status/assignee history to the selected provider and asks for structured JSON (Claude tool use, OpenAI/local JSON schema, Gemini response schema). For local servers without JSON-schema support, it falls back to plain JSON mode.
- If you set the **Server name field** / **Location field** in settings, those Jira field values are used exactly instead of the model's extraction.

## Notes
- Works on `*.atlassian.net` out of the box. Add self-hosted Jira hostnames in settings.
- API keys are stored in Chrome's local extension storage. Don't share a copy of your Chrome profile that contains them.
- With cloud providers, ticket contents are sent to that provider. With a local model, nothing leaves your machine.
- Local models: use a 7B+ instruct model (e.g. Qwen 2.5, Llama 3.1). Very small models may return incomplete results.
- A local server on another machine (e.g. `http://192.168.1.50:1234/v1`) works too. Chrome asks for permission when you save.
