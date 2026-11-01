# Lambda DC Ops Assistant (Chrome extension)

A side panel for Datacenter Operations. Open a Jira ticket and get a one-glance work brief: is it safe to power down, what to do, where the server is, its NetBox record and BMC health, the right replacement part with its Lambda P/N and where it's in stock, and an AI you can ask follow-up questions. Works on Mac and Windows, with Claude, OpenAI, Gemini or a local model.

**Help, bugs or feature ideas:** message the developer, [Hadi Khodja on Slack](https://lambda.slack.com/team/U0AAMLCUCUA). The link is also at the bottom of the panel and of Settings.

## Quick start
1. **Load the extension:** `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select this `jira-assistant` folder. Pin it and click its icon to open the side panel. Settings opens on first install.
2. **Get an AI key.** Settings → **Start** → *Getting started* has a ready-to-send request for IT. Claude (Anthropic) is recommended; OpenAI and Gemini also work.
3. **Install the helper** (ping, BMC). Settings → *Getting started* → **Copy** the setup command and run it: on a Mac in **Terminal**, on Windows in **PowerShell**. It asks before installing anything.
4. **Paste the key**, click **Load models**, then **Save**. Open any Jira ticket.

To update: pull the latest version, then click **reload** on the extension in `chrome://extensions`. The footer of the panel shows the version.

## The panel, top to bottom
- **No ticket in this tab?** A start screen says to go to a Jira ticket tab, lists the tickets already open in your tabs (click one to go there), and reminds you to add an AI key if there isn't one.
- **Header** (stays on screen): ticket key, **Re-analyze**, Settings, a progress line (✓ Ticket · ✓ AI brief · ✓ NetBox · ✕ Ping 1/2 up) and jump links (✅ Steps · 🔧 BMC · 🕘 History · 🗄️ NetBox).
- **Ticket strip**: job type, status, priority; 👤 assignee and 📝 reporter (click a name to message them on Slack).
- **⏻ Power-down verdict**: ✓ OK · i Not needed · ! Confirm first · ✕ Do NOT, with reason and evidence. Without explicit approval in the ticket it never says OK.
- **📋 Request** and **⚠️ Cautions**.
- **🖥️ Server & 📍 Location**: hostnames (click to copy), site, row/rack/RU, any ticket-vs-NetBox mismatch, and **📡 Reachability** (ping of the ticket's and NetBox's IPs, with the network you go out on, e.g. `via utun4 (VPN)`).
- **🔧 BMC**: health and power control (below).
- **✅ Next steps** checklist (risky steps in red; a Podcrawler rescan step is added for replacements) and **🧰 Parts & tools** with the parts catalog and stock (below).
- **🕘 History**, **🗄️ NetBox** and **❓ To confirm** (collapsed; they remember if you open them).
- **📋 Copy as Jira comment** at the end, and the **💬 Ask the AI** box docked at the bottom.

The brief streams in as the AI writes it. Results, checklist ticks and chats are kept per ticket until the browser restarts.

## Features

### BMC
- Each BMC IP (from the ticket or NetBox) with a ping dot. If the BMC doesn't answer, the card says so: you need the VPN or the datacenter network.
- **Check health** asks for the BMC password (username `ADMIN`, changeable): *Copy IP*, find it in 1Password (⌘⇧Space / Ctrl+Shift+Space), copy the password, paste it. Shows power state, health, model, serial, BIOS/BMC firmware, failed parts and event-log warnings, and flags a serial that doesn't match the ticket/NetBox.
- **⏻ Power off… / Power on…** after a health check. Deliberately slow: the panel shows the ticket's power-down verdict, you pick *Shut down* (clean) or *Force off*, and type the BMC IP (no paste) to unlock the button. The helper checks again and only sends the BMC's own Redfish reset. The action goes into the Jira comment.
- Tip: set each BMC item's website in 1Password to `https://<bmc-ip>` so 1Password fills the login when you click **Open**.

### Parts: catalog, stock and AI
- **The part number on a ticket is usually the server/chassis, not the part to swap.** Numbers found in the ticket are listed as *mentioned in the ticket*, whole servers are marked, and the AI never treats them as the replacement part.
- **🖥️ This server**: the server's own catalog entry from NetBox's Lambda SKU (`legacy_LPN`), e.g. "Hyperplane 8-H100 Intel 8U Chassis", so you know the GPU generation.
- Every part leads with its **Lambda P/N** (what parts are tracked by), then legacy SKU, MPN and description, all click-to-copy. *No Lambda P/N* is flagged; if the same MPN is listed with one, the card points to that row. Parts the BMC reports as failed come first.
- **🔎 Find a part** searches the catalog. **📒 Open catalog** / **Open in catalog** open the sheet (on the part's row) to confirm before ordering.
- **📦 Check stock** looks the part up in NetBox storage (stock counts and stored serialized spares), **this site first**, e.g. "155 at ORD01 — ORD01-Storage-Cabinet 114, ORD01DH1-Storage-Ra3-Shelf2 41". If it isn't stocked under its own numbers, it finds the same kind of part by MPN or description (e.g. Samsung 64 GB DDR5 RDIMM → 207-000002 Hynix 64 GB DDR5 RDIMM).
- **Used** adds the part to the Jira comment, led by its Lambda P/N.
- **✨ Ask AI which part** / "Which part do I need to swap?": the chat works out the failing component (ticket, comments, BMC, server's catalog entry, NetBox journal), searches the catalog for it and answers with the most likely part (Lambda P/N first). **NetBox stock for the parts the answer names is then looked up and shown under it** (this site first, with locations). A 🔎 note shows what it searched. Part types are recognised by name, Lambda P/N family (206 GPUs, 204 GPU baseboards, 205 CPUs, 207 memory, 208/209 drives, 211 NICs, 214 PSUs, 216/236–238 cables & optics; 201/203 whole systems) and legacy SKU prefix (GPU, RAM, DDR = drives, PSU, FAN, NIC, MBD, CPU, CB* = cables; CSN/DGX = whole systems).

### NetBox
Status, model, site/rack/RU, serial, Lambda SKU, asset tag, tenant/cluster, IPs, interfaces & cabling, **📝 Journal** (work history; lines with passwords are removed), **🧩 Modules** (mostly switch transceivers; NetBox doesn't record GPUs/DIMMs in servers) and the last **Podcrawler** activity (**Open** copies the hostname). Read-only.

### Ask the AI
Short, dense answers about the open ticket ("what does Xid 79 mean?", "draft a reply to the requester", "do we have 207-000002 in stock?"). The AI sees the ticket, the brief, NetBox, BMC health, and for part/stock questions the matching catalog rows and stock.

### People → Slack
Click a name to open your Slack chat with that person, ready to type. With Slack in Chrome, the extension uses your Slack tab (or opens one) and does what you would: ⌘K / Ctrl+K, type the name, pick the person. It reads nothing from Slack, sends nothing and needs no token. With the Slack desktop app (Settings → Jira & AI → People) the name is copied: press ⌘K / Ctrl+K and paste.

### Privacy mode
Settings → **Privacy**: before anything is sent to the AI, names, emails, phone numbers, IP/MAC addresses, serials and your own words (e.g. customer names) become placeholders like `[IP-1]`; the real values are put back on your computer. Passwords, tokens and API keys in tickets are always removed. The footer shows 🔒 how many were hidden.

## Settings
Four tabs, Save always at the bottom:
- **Start**: getting started, AI provider, key, model (**Test AI** sends a one-line question with your key and model and shows the answer and how long it took), response speed, and **back up / load settings** (a JSON file; API keys and the NetBox token only if you tick the box, so a file can be shared with the team).
- **Servers & BMC**: ping helper, BMC username and web address, NetBox & Podcrawler, parts catalog link.
- **Privacy**: privacy mode.
- **Jira & AI**: self-hosted Jira hosts, server/location fields, people (Slack app or browser), team context and custom AI instructions.

## Setup details

### Helper (ping and BMC)
Browsers can't ping or talk to BMCs, so a small Python helper does it through Chrome's native messaging. The setup command installs it; to install it on its own, use the command under Settings → Servers & BMC:
- The commands in Settings find the `jira-assistant` folder wherever it is (Desktop, Downloads…): they look up the folder Chrome loaded the extension from, by its ID. If that fails, run the script by hand: `bash <folder>/setup.sh <extension-id>` (Windows: `powershell -ExecutionPolicy Bypass -File "<folder>\setup.ps1" <extension-id>`); dragging the file into Terminal/PowerShell types its path.
- Mac/Linux: `bash <folder>/ping-helper/install.sh <extension-id>` (remove: `ping-helper/uninstall.sh`). Needs python3 (`xcode-select --install`).
- Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File "<folder>\ping-helper\install.ps1" <extension-id>` (remove: `uninstall.ps1`). Needs Python 3 (`winget install Python.Python.3.13`).
- Installed to `~/Library/Application Support/DCOpsPingHelper` or `%LOCALAPPDATA%\DCOpsPingHelper`, registered for Chrome, Edge, Brave and Chromium. **Test ping helper** in Settings shows its version and TLS library.
- It prefers a Python with TLS 1.3; if a BMC refuses the connection it retries with `curl`.

### NetBox, catalog, Jira
- **NetBox**: uses your NetBox login in Chrome. If that doesn't work, paste a read-only API token in Settings. **Test NetBox** checks it.
- **Parts catalog**: by default the Lambda `catalog` Google Sheet (Lambda part number, description, manufacturer P/N or legacy SKU), opened with your Google login and read once a day. Paste another link in Settings → Servers & BMC (a Google Sheet or an Excel file in Drive); clear the field to go back to the default. **Test catalog** checks it. "(CAPEX)" copies, test items and licences/services (4xx-) are skipped; parts marked "EOL, USE … INSTEAD" are tagged *EOL* with the replacement P/N.
- **Jira**: read through Jira's REST API in your tab with your login (no token). Works on `*.atlassian.net`; add self-hosted hosts in Settings. Optional exact field names for server and location.
- **BMC web address**: `https://{ip}` by default; change it if your BMCs use http or a port.

## Speed and AI providers
| Provider | What you need |
|---|---|
| Anthropic (Claude) | API key from console.anthropic.com |
| OpenAI | API key from platform.openai.com |
| Google Gemini | API key from aistudio.google.com |
| Local – LM Studio | LM Studio server running (default `http://localhost:1234/v1`) |
| Local – Ollama | `ollama serve` (default `http://localhost:11434/v1`); on a 403 set `OLLAMA_ORIGINS=chrome-extension://*` |

- *Auto* picks a fast, accurate model (newest Claude Sonnet, a GPT "mini", Gemini Flash). **Response speed** (Fast by default) controls how long it thinks; on Fast, Claude's thinking is turned off where the model allows it.
- Briefs use structured output (JSON schema), stream in, and the Claude system prompt is cached between tickets. Local models: use a 7B+ instruct model.

## Data and security
- With a cloud provider, the ticket (and for chat questions, matching catalog rows and stock) goes to that provider; with a local model nothing leaves your computer. Privacy mode hides sensitive values either way.
- BMC passwords are only pasted, kept in memory until the panel closes, and sent only to the BMC (private IPs, HTTPS) through the local helper. Never saved, never sent to the AI.
- NetBox, the catalog and Slack are only read. The one write the extension can make is the confirmed BMC power action.
- API keys are stored in Chrome's local extension storage.
- ⚠️ Some NetBox journal entries contain BMC passwords in plain text ("PWD - …"). The extension strips those lines, but they should be removed from NetBox.

## Project layout
| File | What it does |
|---|---|
| `manifest.json` | Extension manifest (permissions, version) |
| `background.js` | Service worker: opens the side panel, request headers, clears removed settings |
| `sidepanel.html` / `sidepanel.js` | The panel: reads the ticket, runs the AI and all lookups |
| `render.js` | Draws the brief, ping and NetBox cards |
| `analysis.js` | Brief schema, AI instructions, Jira comment |
| `common.js` | Settings, AI providers (Claude, OpenAI, Gemini, local), streaming |
| `chat.js` | Ask-the-AI box, part search planning |
| `catalog.js` | Parts catalog: load, match, search, catalog rows for the AI, Parts card |
| `netbox.js` | NetBox lookup, journal, modules, spare stock |
| `bmc.js` | BMC card: health, power panel |
| `ping.js` | Ping targets and the native-messaging call to the helper |
| `slack.js` | Opens a Slack DM in your Slack tab |
| `privacy.js` | Privacy mode placeholders |
| `icons.js`, `icons/` | Line icons and the λ logo |
| `options.html` / `options.js` | Settings page |
| `styles.css` | Styles for both pages (light and dark) |
| `ping-helper/` | Python helper (ping, Redfish) and its Mac/Windows installers |
| `setup.sh` / `setup.ps1` | One-step setup for Mac / Windows |

`icons/logo.svg` is a λ mark in Lambda violet; to use the official logo, replace it and `icons/icon16/32/48/128.png` with artwork of the same sizes.
