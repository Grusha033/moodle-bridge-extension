# Moodle Agent Bridge (Browser Extension)

A Chrome / Edge / Brave browser extension that syncs verified Moodle quiz answers with a shared cloud database and highlights the right answer with an animated pointer — even when Moodle shuffles question and option order.

## Features

- **Instant cloud sync**: Connects automatically to the shared database — no login, no tokens, no Python required.
- **Shuffle-proof matching**: Matches questions by normalized text and strips answer numbering prefixes (`1.`, `a.`, etc.), so randomized attempts still match 100%.
- **One-click save from past quizzes**: Open any completed quiz review page (`review.php`) and click **Save to DB** to contribute verified answers for everyone.
- **Expandable quiz panel**: View all questions in the current quiz, jump directly to any question, and see which answers are ready (`DB 100%`, `NEW`, `UPD`, `WAIT`).
- **Quick hide hotkey**: Press `Alt+M` to hide or show the answer pointer at any time.

## Installation

1. Download this repository: click **Code -> Download ZIP** and extract it to a folder (or run `git clone https://github.com/Grusha033/moodle-bridge-extension.git`).
2. Open `chrome://extensions/` in Chrome, Edge, or Brave.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the extracted folder.
5. Done! Open any Moodle quiz — answers will load automatically.

## Updating

The extension checks this repository for new releases automatically and shows an **`UPD`** badge on its toolbar icon when an update is available.

To update in one click:
- **Windows**: double-click `update.bat` inside the extension folder.
- **Linux / macOS**: run `./update.sh` inside the extension folder.
- Then open `chrome://extensions/` and click the **Reload** icon on **Moodle Agent Bridge**.

> Note: Chrome's security sandbox prevents extensions from directly executing local `.bat`/`.sh` files from the browser, so running the included updater script (or downloading the ZIP from the popup) is the fastest way to update unpacked extensions.
