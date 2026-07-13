# ST-Connection-Rotator

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that automatically rotates between [Connection Manager](https://docs.sillytavern.app/extensions/connection-manager/) profiles on a per-message schedule.

## Features

- **Ordered mode** — each profile runs for a configurable number of consecutive messages, then the next profile takes over. The schedule loops indefinitely.
- **Weighted mode** — each message picks a profile at random, with probability proportional to the assigned weight.
- **Per-chat or global counter** — track rotation position independently per chat, or share a single global counter across all chats.
- **Swipe control** — optionally include or exclude swipes from the rotation.

## Installation

1. In SillyTavern, open **Extensions** → **Install Extension**.
2. Paste the repository URL:
   ```
   https://github.com/Rsslone/ST-Connection-Rotator
   ```
3. Click **Install**. The extension will appear under **Extensions Settings** as **Connection Rotator**.

## Usage

1. Open the **Connection Rotator** panel in Extension Settings.
2. Click **Add** to create one or more rotation entries.
3. For each entry, select a Connection Manager profile and set a weight (ordered: number of messages; weighted: relative probability).
4. Choose a **Mode**:
   - **Ordered** — profiles cycle in order, each for its configured number of messages.
   - **Weighted** — each message randomly selects a profile proportional to its weight.
5. Toggle **Enabled** to activate rotation.

### Options

| Option | Description |
|---|---|
| Enabled | Master on/off switch |
| Per-chat counter | When on, each chat tracks its own position in the rotation |
| Include swipes | When on, swipes switch to the current slot's profile (counter does not advance) |
| Mode | Ordered or Weighted (see above) |
| Reset | Resets the counter to 0 |

### Status bar

The status bar shows the **next profile** that will be used and the current **counter** value.

## Example

Ordered mode with three entries:

| Profile | Weight (msgs) |
|---|---|
| Fast Model | 5 |
| Smart Model | 5 |
| Reasoning Model | 1 |

Every 11 messages the schedule repeats: 5 on Fast, 5 on Smart, 1 on Reasoning.

Weighted mode with the same entries (`weight` = 5, 5, 1) would pick Fast or Smart roughly 45% of the time each, and Reasoning roughly 9% of the time, chosen randomly per message.

## License

GPL-3.0 — see [LICENSE](LICENSE).
