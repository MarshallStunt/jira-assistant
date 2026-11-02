# Lambda Rackside (Chrome extension)

*The DC Ops ticket assistant.*

A side panel for Datacenter Operations. Open a Jira ticket and get a one-glance work brief: is it safe to power down, what to do, where the server is, its NetBox record and BMC health, the right replacement part with its Lambda P/N and where it's in stock, and an AI you can ask follow-up questions. Works on Mac and Windows, with Claude, OpenAI, Gemini or a local model.

**Help, bugs or feature ideas:** message the developer, [Hadi Khodja on Slack](https://lambda.slack.com/team/U0AAMLCUCUA). The link is also at the bottom of the panel and of Settings.

**Finding your way:** every section has its own colour (a stripe, a tinted header and a chip in the jump bar at the top). Tap a chip to jump to it; the section you're reading is lit up as you scroll. The chips show progress: **✅ Steps 2/5** as you tick steps (✓ when all are done) and **🔁 RMA ✓** once the RMA ticket is created.

## Quick start
1. **Load the extension:** `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select this `lambda-rackside` folder. Pin it and click its icon to open the side panel. Settings opens on first install.
2. **Get an AI key.** Settings → **Start** → *Getting started* has a ready-to-send request for IT. Claude (Anthropic) is recommended; OpenAI and Gemini also work.
3. **Install the helper** (ping, BMC). Settings → *Getting started* → **Copy** the setup command and run it: on a Mac in **Terminal**, on Windows in **PowerShell**. It asks before installing anything.
4. **Paste the key**, click **Load models**, then **Save**. Open any Jira ticket.

**Updates:** Chrome checks the private GitHub repo every 2 hours, and the panel checks on every Analyze / Re-analyze, with your GitHub login (you need access to the repo). A new version shows a red **NEW** badge on the toolbar icon, one notification (click it to open Settings → Updates), and a 🆕 banner at the top of the panel; **Later** hides the banner and badge until the next version. **⬇️ Update now** downloads it with your GitHub login, the helper puts it in your lambda-rackside folder (`git pull` if it's a git copy, otherwise the new files over the old ones) and updates itself, and the extension reloads. *Update by hand* has a command that does the same from Terminal/PowerShell (or a ZIP link). Settings → Start → **Check for updates** checks right away. Needs helper 1.6.0 or later: older helpers update by hand once. The footer of the panel shows the version.

## The panel, top to bottom
- **🆕 Update banner** when GitHub has a newer version (see *Updates* above).
- **No ticket in this tab?** A start screen says to go to a Jira ticket tab, lists the tickets already open in your tabs (click one to go there), and reminds you to add an AI key if there isn't one.
- **Header** (stays on screen): ticket key, **Re-analyze**, Settings, a progress line (✓ Ticket · ✓ AI brief · ✓ NetBox · ✕ Ping 1/2 up) and a jump bar with every section in its colour (📋 Request · 🖥️ Server · 🔧 BMC · ✅ Steps · 🧰 Parts · 🔁 RMA · 🕘 History · 🗄️ NetBox).
- **Ticket strip**: job type, status, priority; 👤 assignee and 📝 reporter (click a name to message them on Slack).
- **⏻ Power-down verdict**: ✓ OK · i Not needed · ! Confirm first · ✕ Do NOT, with reason and evidence. Without explicit approval in the ticket it never says OK.
- **⚡ At a glance**: the one card to read, filled from live systems first and the ticket only for the job. One line each:
  - **🎯 Job** (from the ticket) · **📍 Where**: hostname, site, rack, RU from **NetBox** (marked *NetBox ✓*, or ⚠️ when it disagrees with the ticket)
  - **📡 Live**: host and BMC up/down from ping, the BMC's power state and failed parts once health is read, "chassis most likely powered off"
  - **🧰 Part**: the BMC's failed part or the best catalog match, with its spare stock at your site looked up automatically ("3 in stock at ORD01", or "none here, 12 elsewhere")
  - **⚠️ Cautions** · **👉 Next**: the first step not done, with **✓ Done** to tick it
  Tap a line to open its section.
- **📋 Request**, **⚠️ Cautions**, **🖥️ Server & 📍 Location** and **🧰 Parts & tools** start folded (everything in them is summed up in *At a glance*); open any of them, and it stays open next time.
- **🖥️ Server & 📍 Location**: hostnames (click to copy), site, row/rack/RU, any ticket-vs-NetBox mismatch, and **📡 Reachability** (ping of the ticket's and NetBox's IPs, with the network you go out on, e.g. `via utun4 (VPN)`). If the server doesn't answer ping (and its BMC does), it says the chassis is most likely already powered down; that note also goes into the Jira comment.
- **🔧 BMC**: health, 🖥️ remote console and power control (below).
- **✅ Next steps** checklist (risky steps in red; a Podcrawler rescan step is added for replacements) and **🧰 Parts & tools** with the parts catalog and stock (below).
- **🕘 History**, **🗄️ NetBox** and **❓ To confirm** (collapsed; they remember if you open them).
- **📋 Copy as Jira comment** at the end, and the **💬 Ask the AI** box docked at the bottom.

The brief streams in as the AI writes it. Results, checklist ticks and chats are kept per ticket until the browser restarts.

## Features

### BMC
- Each BMC IP (from the ticket or NetBox) with a ping dot. If the BMC doesn't answer, the card says so: you need the VPN or the datacenter network.
- **Check health** asks for the BMC password (username `ADMIN`, changeable): *Copy IP*, find it in 1Password (⌘⇧Space / Ctrl+Shift+Space), copy the password, paste it. Shows power state, health, model, serial, BIOS/BMC firmware, failed parts and event-log warnings, and flags a serial that doesn't match the ticket/NetBox.
- **⏻ Power off… / Power on…** after a health check. Deliberately slow: the panel shows the ticket's power-down verdict, you pick *Shut down* (clean) or *Force off*, and type the BMC IP (no paste) to unlock the button. The helper checks again and only sends the BMC's own Redfish reset. The action goes into the Jira comment.
- **🖥️ Console** opens the server's live remote console (screen, keyboard, mouse: the BMC's HTML5 iKVM) in a new tab, already logged in. Paste the BMC password once; the helper asks the BMC's Redfish API (Supermicro) for a console link with a one-time login, so there's no login page. If Chrome warns about the BMC's certificate, click Advanced → Proceed. BMCs without that link (other vendors, old firmware): use **Open**, log in, then Remote Control → Launch.
- Tip: set each BMC item's website in 1Password to `https://<bmc-ip>` so 1Password fills the login when you click **Open**.

### Parts: catalog, stock and AI
- **The part number on a ticket is usually the server/chassis, not the part to swap.** Numbers found in the ticket are listed as *mentioned in the ticket*, whole servers are marked, and the AI never treats them as the replacement part.
- **🖥️ This server**: the server's own catalog entry from NetBox's Lambda SKU (`legacy_LPN`), e.g. "Hyperplane 8-H100 Intel 8U Chassis", so you know the GPU generation.
- Every part leads with its **Lambda P/N** (what parts are tracked by), then legacy SKU, MPN and description, all click-to-copy. *No Lambda P/N* is flagged; if the same MPN is listed with one, the card points to that row. Parts the BMC reports as failed come first.
- **🔎 Find a part** searches the catalog. **📒 Open catalog** / **Open in catalog** open the sheet (on the part's row) to confirm before ordering.
- **📦 Check stock** looks the part up in NetBox storage (stock counts and stored serialized spares), **this site first**, e.g. "155 at ORD01 — ORD01-Storage-Cabinet 114, ORD01DH1-Storage-Ra3-Shelf2 41". If it isn't stocked under its own numbers, it finds the same kind of part by MPN or description (e.g. Samsung 64 GB DDR5 RDIMM → 207-000002 Hynix 64 GB DDR5 RDIMM).
- **Used** adds the part to the Jira comment, led by its Lambda P/N.
- **✨ Ask AI which part** / "Which part do I need to swap?": the chat works out the failing component (ticket, comments, BMC, server's catalog entry, NetBox journal), searches the catalog for it and answers with the most likely part (Lambda P/N first). **NetBox stock for the parts the answer names is then looked up and shown under it** (this site first, with locations). A 🔎 note shows what it searched. Part types are recognised by name, Lambda P/N family (206 GPUs, 204 GPU baseboards, 205 CPUs, 207 memory, 208/209 drives, 211 NICs, 214 PSUs, 216/236–238 cables & optics; 201/203 whole systems) and legacy SKU prefix (GPU, RAM, DDR = drives, PSU, FAN, NIC, MBD, CPU, CB* = cables; CSN/DGX = whole systems).

### RMA
After swapping a failed part, open an RMA ticket for it without leaving the DC ticket. Everything is pre-filled; you check it and confirm. Nothing is sent to Jira before you do.

**How to use it**
1. In the **🔁 RMA** card (pink, under Parts), click **Create RMA ticket…**.
2. Check the form: the failed part, the old and new S/N, a description, the component. Each value shows where it came from (e.g. "from Hadi Khodja's comment", "NetBox ✓ new S/N", "catalog: exact description") until you edit it.
3. **Review →** lists every value. Tick "I checked the part number and both serial numbers against the parts", then **✅ Create RMA ticket** (or **✅ Add to RMA-…**).
4. The RMA link shows in the card and goes into **Copy as Jira comment**. **↺ Reset** starts over (nothing in Jira changes).

**What it does in Jira**
- **No RMA yet:** creates one ticket in the **RMA** project, of the kind you choose (**Advance Replacement** by default; also CRU, Manufacturing Repair, Onsite Warranty, Return to Vendor). It copies the server details from the DC ticket (every field both have: hostname, chassis SN, device type, site, location, data center, NetBox links, IPs, rack), fills in Faulty Part SN, Replacement SN, Faulty Part Number, MPN, Component Issue and RMA type, and links it to the DC ticket (**relates to**). No other DC ticket is created.
- **The DC ticket already has an RMA** (linked to it or to one of its sub-tasks): no new ticket. The part and serials are added to that RMA as an **internal comment** (pick which RMA if there are several).
  - The serials already on that RMA are listed. A swap counts as already there when its old **and** new S/N are in the same comment (or its description or S/N fields); it is skipped and the next swap the ticket mentions is proposed. If every swap is there, it says there's nothing new to add.

**The serial numbers: from one comment**
- The old and new S/N are taken from the **same comment**: the tech who swapped writes both ("Old s/n: X / New s/n: Y", "OLD: X New: Y"). Never one from one comment and one from another.
- A tech's comment beats the ticket description (which only names the failed part, e.g. "requesting replacement of GPU 8 (SN …)"). A serial can never be both old and new.
- The BMC's serial for the failed component (helper 1.6.2+) can also give the old S/N; if it disagrees with the ticket, you get a warning.
- Serials the AI suggests are kept only if they appear in the ticket or BMC data.

**The part number: the catalog is the source of truth**
The Lambda P/N and MPN are always a **catalog** part, settled in this order:
1. **NetBox, by serial:** the new S/N (the spare you installed: inventory asset "<P/N>_<serial>") or the old S/N (an installed module) gives the exact P/N.
2. A part you ticked **Used**, or the BMC's failed part whose MPN is in the catalog exactly.
3. **A P/N, SKU or MPN named in the ticket**, the swap comment first ("Replaced 211-000027").
4. **What techs used before** on the same server model for the same component (past RMA tickets), when one part clearly dominates ("used N× on <model>").
5. **An exact, unambiguous catalog description** match, from the ticket's sentences ("Switch board is replaced") or the description you type. Only words the catalog uses count; every word must be in the entry; specs must not conflict (80GB vs 141GB, H100 vs H200, DDR4 vs DDR5, SXM vs PCIe); and the part must **fit the server** (an SXM4/A100 part in an H100/SXM5 server is tagged "doesn't fit this server", listed last and never filled in).
6. Otherwise **you choose** from the list. It's never empty: with no description match it lists the catalog parts for the chosen Component that fit the server, and typing a Lambda P/N, SKU or MPN finds that part. Tags: NetBox ✓, P/N named in the swap comment, used N×, exact, same description as …, EOL → replacement, doesn't fit this server.

A part you pick yourself is never replaced; if NetBox or the history disagree, you get a warning. A Lambda P/N fills in the MPN and name, and an MPN fills in the Lambda P/N. Anything you type is never replaced by a suggestion.

**Checks before anything is sent:** both serials and a part number are required; the same S/N can't be old and new; a swap already on the existing RMA is refused. Everything runs in your Jira tab with your login, and fields are found by name. If linking fails, it tells you the RMA ticket was created and to link it in Jira.

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
- **Start**: getting started, **updates**, AI provider, key, model (**Test AI** sends a one-line question with your key and model and shows the answer and how long it took), response speed, and **back up / load settings** (a JSON file; API keys and the NetBox token only if you tick the box, so a file can be shared with the team).
- **Servers & BMC**: ping helper, BMC username and web address, NetBox & Podcrawler, parts catalog link.
- **Privacy**: privacy mode.
- **Jira & AI**: self-hosted Jira hosts, server/location fields, people (Slack app or browser), team context and custom AI instructions.

## Setup details

### Helper (ping and BMC)
Browsers can't ping or talk to BMCs, so a small Python helper does it through Chrome's native messaging. The setup command installs it; to install it on its own, use the command under Settings → Servers & BMC:
- The commands in Settings find the `lambda-rackside` folder wherever it is (Desktop, Downloads…): they look up the folder Chrome loaded the extension from, by its ID. If that fails, run the script by hand: `bash <folder>/setup.sh <extension-id>` (Windows: `powershell -ExecutionPolicy Bypass -File "<folder>\setup.ps1" <extension-id>`); dragging the file into Terminal/PowerShell types its path.
- Mac/Linux: `bash <folder>/ping-helper/install.sh <extension-id>` (remove: `ping-helper/uninstall.sh`). Needs python3 (`xcode-select --install`).
- Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File "<folder>\ping-helper\install.ps1" <extension-id>` (remove: `uninstall.ps1`). Needs Python 3 (`winget install Python.Python.3.13`).
- Installing again for another copy of the folder (another extension ID) keeps the earlier one working too.
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
- NetBox, the catalog and Slack are only read. The update check only reads the version number from the GitHub repo; **Update now** downloads the repo and writes only to the extension's own folder (found from its ID) and the helper's install folder. The one write the extension can make is the confirmed BMC power action.
- API keys are stored in Chrome's local extension storage.
- ⚠️ Some NetBox journal entries contain BMC passwords in plain text ("PWD - …"). The extension strips those lines, but they should be removed from NetBox.

## Project layout
| File | What it does |
|---|---|
| `manifest.json` | Extension manifest (permissions, version) |
| `background.js` | Service worker: opens the side panel, request headers, clears removed settings, new-version check (badge, notification) |
| `sidepanel.html` / `sidepanel.js` | The panel: reads the ticket, runs the AI and all lookups; update banner, start screen |
| `render.js` | Draws the brief, ping and NetBox cards |
| `analysis.js` | Brief schema, AI instructions, Jira comment |
| `common.js` | Settings, developer contact, folder commands (setup, update), update check, AI providers (Claude, OpenAI, Gemini, local), streaming |
| `chat.js` | Ask-the-AI box, part search planning |
| `catalog.js` | Parts catalog: load, match, search, catalog rows for the AI, Parts card |
| `netbox.js` | NetBox lookup, journal, modules, spare stock |
| `bmc.js` | BMC card: health, remote console, power panel |
| `rma.js` | RMA card: part and serials prompt, catalog matching, review, creates and links the RMA ticket (or comments on the existing one) |
| `ping.js` | Ping targets and the native-messaging call to the helper |
| `slack.js` | Opens a Slack DM in your Slack tab |
| `privacy.js` | Privacy mode placeholders |
| `icons.js`, `icons/` | Line icons and the λ logo |
| `options.html` / `options.js` | Settings page (tabs, Test AI, backup & restore, updates) |
| `styles.css` | Styles for both pages (light and dark) |
| `ping-helper/` | Python helper (ping; BMC health, console link and power over Redfish; self-update) and its Mac/Windows installers |
| `setup.sh` / `setup.ps1` | One-step setup for Mac / Windows |

`icons/logo.svg` is a λ mark in Lambda violet; to use the official logo, replace it and `icons/icon16/32/48/128.png` with artwork of the same sizes.
