# Lambda Rackside: privacy policy

*Last updated: November 6, 2026*

Lambda Rackside is a Chrome extension for Lambda's Datacenter Operations team. It shows a brief for the Jira ticket open in the current tab, using the systems the user already has access to. This page explains what data it uses and where that data goes.

## What it reads
- **The Jira ticket in the current tab** (summary, description, fields, comments and linked tickets), through Jira's REST API with the user's own Jira login in Chrome.
- **NetBox** (server, location, inventory and journal records), with the user's NetBox login in Chrome or a read-only API token the user enters.
- **The parts catalog** (a Google Sheet), with the user's Google login in Chrome.
- **The server's BMC** (health, event log), only when the user clicks *Check health* and pastes the BMC password, through a helper program installed on the user's computer.

## Where data goes
- **The AI provider the user chooses** (Anthropic, OpenAI, Google Gemini, or a local model on the user's computer) receives the ticket and related server details so it can write the brief and answer questions. It is sent with the user's own API key. With *Privacy mode* on, names, IP addresses, serial numbers and other values are replaced with placeholders before anything is sent. With a local model nothing leaves the computer.
- **Jira:** the extension writes to Jira only when the user asks it to, such as creating an RMA ticket or adding a comment, and only after the user reviews and confirms.
- **BMC:** BMC passwords are kept in memory only until the panel closes, sent only to that BMC through the local helper, never saved and never sent to an AI provider.
- **Nothing is sent to the developer.** The extension has no analytics, tracking, advertising or remote logging, and the developer runs no server that receives data from it.

## What it stores
Settings, API keys and the NetBox token are stored in Chrome's local extension storage on the user's computer. They are not synced or shared. Users can remove them at any time in Settings or by uninstalling the extension.

## Data sharing
User data is not sold or transferred to third parties, except to the AI provider the user selects for the purpose described above. It is not used for anything unrelated to the extension's single purpose, and not used to determine creditworthiness or for lending.

## Contact
Questions: Hadi Khodja, marshallstunt@gmail.com.
