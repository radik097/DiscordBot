# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Discord.js bot that manages server structure (roles, channels, permissions), provides music playback, and includes a web control panel. The bot is written in JavaScript/ESM and runs on Bun.

## Development Commands

```bash
# Start the bot
bun run src/index.js

# Deploy slash commands to Discord (must run after adding/modifying commands)
bun run src/deploy-commands.js

# Validate server structure config without applying changes
bun run src/validate-config.js
```

## Project Structure

### Core Bot Files
- **`src/index.js`** — Main bot entry point. Initializes the Discord client, loads commands, sets up event handlers for:
  - Guild member joins (auto-assign "Новичёк" role)
  - Slash command execution
  - Rules acceptance button handling
  - Message logging (create/edit/delete)
  - Bot-only channel enforcement
  - Web server startup

### Command System
- **`src/commandLoader.js`** — Dynamically loads all command files from `src/commands/`. Each command file exports either a single `{data, execute}` object or a `commands` array (for related commands sharing helpers).
- **`src/commands/`** — Directory containing slash commands:
  - `music.js` — Music playback commands (`/play`, `/skip`, `/stop`, `/queue`, etc.)
  - `rules.js` — Rules publication (`/rules post`)
  - `setup.js` — Server structure management (`/setup build`, `/setup export`, `/setup wipe`, `/setup validate`)

### Server Structure Management
- **`src/structureManager.js`** — Declarative server configuration system. Reads from `config/structure.json` and applies:
  - **Roles** — Create/update roles with colors, hoisting, permissions
  - **Categories & Channels** — Create/organize channels with permission overwrites
  - **Permission System** — Supports per-role `allow`/`deny` lists, global deny rules (e.g., "Muted can't send messages anywhere"), isolation roles (e.g., "Jailed" role blocked from all channels except specific whitelist)
  - Reverse sync: `exportStructure()` reads the live guild and generates a config snapshot
  - Safety features: `protectedChannels` list, role hierarchy checks, validation before applying

### Music System
- **`src/music/source.js`** — Track resolution from YouTube URLs or search queries; handles download/streaming
- **`src/music/queue.js`** — In-memory queue management, tracks, playback state
- **`src/commands/music.js`** — Commands check role access via `config.musicAllowedRoles`

### Data & Web
- **`src/db.js`** — SQLite database (created in `data/history.sqlite`):
  - Message logging (create/edit/delete with timestamps)
  - History browser queries (by guild/channel)
  - Stats aggregation (top users, top channels, 7-day activity)
- **`src/web/server.js`** — REST API + static file server (runs on `WEB_PORT` or 8787):
  - Serves `/public/` (HTML/JS/CSS control panel)
  - API endpoints for config management, message history, queue, stats
  - No authentication; intended for local/internal use only

## Configuration Files

- **`.env`** — Runtime secrets:
  - `DISCORD_TOKEN` — Bot token from Developer Portal
  - `CLIENT_ID` — Application ID
  - `GUILD_ID` — (Optional) Guild ID for instant slash command deployment (vs. ~1 hour global)
  - `WEB_PORT` — (Optional) Web panel port, defaults to 8787

- **`config/structure.json`** — Declarative server structure:
  - `roles[]` — Define roles (name, color, permissions, hoisting, mentionable)
  - `categories[]` — Define categories with permission overwrites
  - `channels[]` — Define channels (type, category, topic, botOnly flag, roles)
  - `musicAllowedRoles[]` — Roles allowed to use music commands (checked in addition to Administrator)
  - `globalDenyRoles{}` — Deny specific permissions to a role on every channel/category
  - `alwaysAllRoles{}` — Allow specific permissions to a role on every channel/category (for staff lacking Administrator)
  - `isolationRoles[]` — Jail/quarantine roles: deny permissions everywhere except whitelisted channels
  - `protectedChannels[]` — Channel names that cannot be deleted by `/setup wipe`

- **`config/rules.md`** — Rules text displayed by `/rules post` command

## Architecture Notes

### Permission Model
Permissions are applied in layers to avoid conflicts:
1. Role base permissions (set on role creation)
2. Per-category/channel role overwrites
3. Global deny rules (deny on all channels)
4. Always-all rules (allow on all channels)
5. Isolation rules (applied last, can't be overridden by channel-specific rules)

The bot enforces admin-proof protections by explicitly deleting messages in bot-only channels (since Discord's Administrator permission bypasses permission overwrites).

### Event-Driven Architecture
- Bot uses Discord.js gateway intents (`Guilds`, `GuildMembers`, `GuildMessages`, `MessageContent`, `GuildVoiceStates`)
- All commands are slash commands (no prefix)
- Button interactions for rules acceptance trigger role grants

### Web Panel
The control panel (`http://127.0.0.1:8787`) is a client-side app with no backend state — config edits are sent to the bot's REST API and persisted to disk. Intended for server admins with local/network access, not production authentication.

## Adding New Commands

1. Create a file in `src/commands/mycommand.js`
2. Export an object with `data` (SlashCommandBuilder) and `execute(interaction)` function
3. For related commands, export a `commands` array instead
4. Run `bun run src/deploy-commands.js` to register with Discord
5. Restart the bot to reload the command module

Example structure:
```javascript
import { SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("mycommand")
  .setDescription("What it does");

export async function execute(interaction) {
  await interaction.reply("Response");
}
```

## Common Development Tasks

**Add a new role/channel:**
1. Edit `config/structure.json` to add the role/category/channel definition
2. Run `/setup build` in Discord to apply changes
3. If needed, use `/setup export` to sync the live guild back to config

**Test permissions changes:**
1. Use `/setup validate` to check for config syntax/reference errors (offline check)
2. Run `/setup build` to apply to the live guild
3. Check `data/history.sqlite` via web panel `/stats` for activity logs

**Debug a command:**
- Check console output from `bun run src/index.js`
- Web panel logs message history for context
- Add temporary `console.log()` statements and restart the bot
