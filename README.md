# Lambda DC Ops Assistant (Chrome extension)

A side panel for Datacenter Operations. Open a Jira ticket and you get a one-glance work brief:

1. **Power-down verdict**, color-coded: ✅ OK to power down · ℹ️ No power-down needed · ⚠️ Confirm before powering down · ⛔ Do NOT power down. Each verdict includes the reason and who approved it. If there is no explicit approval in the ticket, it never says "OK" and shows "Confirm" instead.
2. **Server & location**: hostname chips (click to copy) and an **Open BMC ↗** button for each BMC IP in the ticket, which opens the BMC web login in a new tab. The site is shown on its own line (code + full name, e.g. **ORD01**, Elk Grove Village, IL (EdgeConnex CHI02)), with Row / Rack / RU below.
   **Reachability**: pings the server's **IP addresses** from the ticket (host, BMC/IPMI, mgmt, data). Hostnames and serial numbers are not pinged. If the AI labels no IPs, it pings any IPv4 addresses it finds in the ticket text. For each one it shows up/down, latency, packet loss, and which of *your* interfaces the traffic goes out on (Wi-Fi, Ethernet or VPN), e.g. `via utun4 (VPN)`.
   **NetBox**: looks the server up in NetBox (by hostname, or serial if no hostname) and shows status, model, site/rack/RU, serial, asset tag, tenant/cluster, host IP, **BMC IP with Open BMC**, and interfaces & cabling (which switch/port each port goes to). If the ticket and NetBox disagree (rack, RU, site or serial), you get a ⚠ warning. NetBox's host and BMC IPs are also pinged.
   **BMC (1Password + health)**: for each BMC IP (from the ticket or NetBox), **🔑 Copy password** finds the BMC's login in 1Password and copies the password; the clipboard is cleared after 30 seconds. **Check health** uses that login to read the server over Redfish (read-only): actual power state, overall health, model, serial, BIOS and BMC firmware, failed components (DIMMs, CPUs/GPUs, fans, PSUs, drives) and recent warnings from the BMC event log. A serial that doesn't match the ticket/NetBox is flagged, so you know you're on the right box. Health results go into the Jira comment and the AI chat; passwords never leave your computer's helper.
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

## Works on Mac and Windows
Everything works on both. Settings shows the right setup command for your computer: `setup.sh` in Terminal on a Mac, `setup.ps1` in PowerShell on Windows (it installs Python with winget if needed). Keyboard hints in the panel use ⌘ on a Mac and Ctrl on Windows.

## Quick start (no technical knowledge needed)
1. **Get an AI key.** Settings → *Getting started* has a ready-to-send message asking IT for a key. Claude (Anthropic) is recommended; OpenAI and Gemini also work.
2. **Install the helper tools.** Settings → *Getting started* → **Copy** the setup command and run it: on a Mac in Terminal (⌘ Space, type *Terminal*), on Windows in PowerShell (Windows key, type *PowerShell*). It checks for Python (and optionally the 1Password CLI), asks before installing anything, and installs the ping/BMC helper.
3. **Paste your key** in Settings, click **Load models**, then **Save**.

## Speed
- **Settings → Response speed** controls how long the AI thinks. *Fast* (default) is right for almost all tickets; the panel shows a live seconds counter while it works and the total time afterwards.
- *Auto* model picks a fast, accurate model: the newest Claude Sonnet, a GPT "mini", or Gemini Flash. Bigger "Opus"/"Pro" models are slower and rarely needed here.
- The brief streams in as the AI writes it: server, location and the start of the brief appear within a few seconds, and the power-down banner shows *Checking…* until the AI has decided.
- On Fast, Claude's thinking is turned off where the model allows it (Haiku 5.5, Sonnet 5.5).
- The Claude system prompt is cached between tickets, and results are cached per ticket until the browser restarts.

## BMC card
- Shows each BMC IP (from the ticket or NetBox) with a green/red dot from the ping check. If the BMC doesn't answer ping, the card says so up front: logging in won't work until you're on the VPN / datacenter network.
- **Check health** asks for the BMC password (username `ADMIN` by default): click *Copy IP*, find it in 1Password, copy the password and paste it; the check starts on paste. It reads power state, health, model, serial, BIOS/BMC firmware, failed parts and event-log warnings.
- **Power off… / Power on…** appear after a health check. Powering off is deliberately slow: open the panel, read the ticket's power-down verdict shown there, choose *Shut down* (clean, recommended) or *Force off*, and type the BMC IP (pasting is blocked) before the button unlocks. The helper checks the confirmation again and only sends the BMC's own Redfish reset action. The power state is re-read afterwards, and the action is added to *Copy as Jira comment*.

## People → Slack
Click a name (assignee, reporter, history) to open the Slack app with that name copied; press ⌘K / Ctrl+K, paste and press Enter to open the chat with them.

## Privacy mode
**Settings → Privacy** hides sensitive data from the AI. Before a ticket (or a chat question) is sent, people's names, emails and phone numbers, IP and MAC addresses, serial numbers and any words you list (e.g. customer names) are replaced with placeholders like `[IP-1]` and `[PERSON-2]`. The AI works with the placeholders; the real values are put back into the brief on your computer, so pinging, NetBox and BMC buttons still work. Passwords, tokens and API keys in tickets are removed and never sent. The footer shows how many values were hidden (🔒). A local model doesn't need this: nothing leaves your computer.

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
Browsers can't send pings, so a small Python helper on your computer does it, via Chrome's native messaging. (The setup command above installs it; these steps are for installing it on its own.)
1. Open the extension's **Settings → Ping & reachability** and click **Copy** next to the install command. It contains your extension's ID.
2. Paste it into **Terminal** and press Enter. It looks like: `bash ~/Desktop/jira-assistant/ping-helper/install.sh <extension-id>`
3. Click **Test ping helper**. You should see ✓.

Notes:
- The helper is copied to `~/Library/Application Support/DCOpsPingHelper` (Mac) or `%LOCALAPPDATA%\DCOpsPingHelper` (Windows) and registered for Chrome, Edge, Brave and Chromium.
- Windows: install with `powershell -ExecutionPolicy Bypass -File ping-helper\install.ps1 <extension-id>`, remove with `ping-helper\uninstall.ps1`.
- It only accepts IP addresses/hostnames and runs `ping` / route lookups without a shell. BMC requests only go to private IPs; the only write it can make is the confirmed Redfish power action (shut down / force off / power on).
- It needs python3. On macOS, if it's missing, run `xcode-select --install`.
- Pings run from *your* computer, so results depend on your network/VPN. "via Wi-Fi" while the server is on a private DC network usually means your VPN isn't connected.
- To remove it: `bash ~/Desktop/jira-assistant/ping-helper/uninstall.sh`
- **BMC web address** (Settings): the Open BMC button uses `https://{ip}` by default. Change it if your BMCs use http or a port, e.g. `http://{ip}:8080`. Expect a certificate warning on BMCs with self-signed certs.

## 1Password & BMC health setup
1. Install the 1Password CLI: `brew install 1password-cli`.
2. In the 1Password app: **Settings → Developer → Integrate with 1Password CLI** (on). The first lookup asks you to approve with Touch ID; approval lasts a while.
3. Re-run the ping helper install command from Settings (1Password and Redfish need helper v1.1.0). **Test ping helper** should show v1.1.0.
4. In **Settings → BMC logins (1Password)**, optionally set the vault, a tag (e.g. `bmc`) and a fallback item (e.g. a shared default BMC login), then click **Test 1Password**.

How the right item is found, in order: the item's website is the BMC IP (best: set `https://<bmc-ip>` as the website, which also lets 1Password autofill the BMC web page) → the BMC IP in the title → the hostname in the title → the serial in the title → the fallback item. The card shows which item was used and warns if several matched.

Notes:
- Logins are only sent to private IP addresses, only over HTTPS (self-signed BMC certificates are accepted), and only for GET requests. The extension can't power anything on or off.
- Passwords stay in the helper: the extension only gets the username and the item name. The clipboard is cleared after 30 seconds unless you've copied something else.
- **No 1Password CLI?** (e.g. the setting is greyed out on a company account) Two fast alternatives: set each BMC item's website in 1Password to `https://<bmc-ip>` so 1Password's Chrome extension fills the login when you click **Open BMC**; and for **Check health** (default *I paste it* mode in Settings), click **Check health**: the BMC IP is copied, press ⌘⇧Space (1Password Quick Access), paste the IP, copy the password and paste it into the panel; the check starts on paste. The username is `ADMIN` by default (Settings → BMC username). The typed login is only sent to the BMC through the local helper and kept in memory until you close the panel; it's never saved or sent to the AI.
- **Read BMC health automatically** is off by default because each read may show a 1Password prompt.

## NetBox & Podcrawler setup
- Nothing to set up if you're logged in to NetBox (`netbox.prod.lambdalabs.cloud`) in Chrome: the extension uses that login. Use **Settings → Test NetBox** to check.
- If it says you're not logged in even though you are, create a read-only API token in NetBox (your profile → API Tokens) and paste it in **Settings → NetBox API token**.
- NetBox data is read-only: the extension never changes anything in NetBox.

## How it works
- Reads the issue through Jira's REST API (`/rest/api/2/issue/KEY`) inside the Jira tab, using your existing login. No Jira token is needed. If the API is blocked, it falls back to the visible page text.
- Sends the issue fields, the latest 40 comments, work logs and status/assignee history to the selected provider and asks for structured JSON (Claude tool use, OpenAI/local JSON schema, Gemini response schema). For local servers without JSON-schema support, it falls back to plain JSON mode.
- If you set the **Server name field** / **Location field** in settings, those Jira field values are used exactly instead of the model's extraction.

## Branding
`icons/logo.svg` is a λ mark in Lambda violet. To use the official Lambda logo, replace `icons/logo.svg` and the `icons/icon16/32/48/128.png` files with official artwork of the same sizes, then reload the extension.

## Notes
- Works on `*.atlassian.net` out of the box. Add self-hosted Jira hostnames in settings.
- API keys are stored in Chrome's local extension storage. Don't share a copy of your Chrome profile that contains them.
- With cloud providers, ticket contents are sent to that provider. With a local model, nothing leaves your machine.
- Local models: use a 7B+ instruct model (e.g. Qwen 2.5, Llama 3.1). Very small models may return incomplete results.
- A local server on another machine (e.g. `http://192.168.1.50:1234/v1`) works too. Chrome asks for permission when you save.
