# Cadmus Question Library Tools

A Chrome extension that provides a UI for bulk editing, importing, and managing questions in [Cadmus](https://cadmus.io) question libraries — replacing the need to run console scripts manually.

## Screenshots

| Import Tab | Bulk Edit Tab |
|:---:|:---:|
| ![Import tab with a file loaded](docs/screenshot-import-tab.png) | ![Bulk Edit tab with log output](docs/screenshot-bulk-edit-tab.png) |

## Features

### Import Questions
- **Fill-in-Blank, MCQ, Matching, Short Answer** — all four question types supported
- **From Excel (.xlsx)** — Reads the standard question bank format; mixed types detected automatically
- **From QTI XML (.xml)** — Reads Blackboard QTI 1.2 XML exports
- Type-specific options (points, shuffle, similarity) per accordion card
- Cross-pollinates distractors for fill-in-blank questions

### Bulk Edit (selected questions)
- **MCQ** — Set points and shuffle choices across all selected multiple-choice questions
- **Matching** — Set points and shuffle pairs across all selected matching questions
- **Short Answer** — Set points and similarity threshold (auto-marking) across all selected short-answer questions

### Delete
- Archive selected questions in bulk (irreversible from the Cadmus UI)

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the extension folder
5. Pin the extension to your toolbar for easy access

## Usage

1. Navigate to a Cadmus Question Library page
   URL format: `https://teach.cadmus.io/{tenant}/assessment/{id}/library`
2. Click the extension icon — the status bar turns **green** when connected
3. Use the accordion cards to:
   - **Edit**: Select questions using the library checkboxes first, then set options and click **Run**
   - **Import**: Pick an `.xlsx` or `.xml` file, review the preview, adjust points/shuffle, and click **Import**
   - **Delete**: Select questions and click **Delete** (confirmation required)

The log panel at the bottom shows real-time progress for all operations.

## Excel Format

The import expects the same column layout as `cadmus_qti_generator.py`:

| Column | Header | Description |
|--------|--------|-------------|
| A | `#` | Row number / question ID |
| B | `Type` | Must contain "Fill in the Blank" |
| C | `Question` | Question text with `___1___`, `___2___` blank markers |
| D | `Bloom Level` | Cognitive level (metadata only) |
| E | `Difficulty` | e.g. ● Easy / ●● Medium / ●●● Hard |
| F | `Topic` | Topic/tag string |
| G | `Answer / Details` | Semicolon-separated accepted answers |
| H | `Explanation` | Feedback shown after answering |
| I | `source_file` | Source filename (metadata only) |

**Answer splitting**: Answers are separated by semicolons. For multi-blank questions, the pool is split across blanks using ceiling division (e.g., 6 answers for 2 blanks → 3 per blank).

## Distractor Logic

When importing fill-in-blank questions, each blank automatically gets **2 distractors** (wrong answers) pulled from other questions in the same file:

1. Prefer answers from the **same blank position** in other questions
2. Fall back to answers from **any blank position** if needed
3. Case-insensitive deduplication prevents duplicate choices
4. Distractors are randomly shuffled for variety

## Development

After making changes to the source files:
- Go to `chrome://extensions`
- Click the **refresh** icon on the extension card
- Re-open the popup — changes take effect immediately (no reinstall needed)

## File Structure

```
├── manifest.json          # Chrome extension manifest (v3)
├── background.js          # Service worker — opens popup as centred window
├── popup.html             # Extension popup UI
├── popup.css              # Popup styles
├── popup.js               # Main logic: parsers, UI wiring, injected actions
├── lib/
│   └── xlsx.mini.min.js   # SheetJS library for browser-side Excel parsing
├── icons/
│   ├── icon16.png         # Toolbar icon
│   ├── icon48.png         # Extensions page icon
│   └── icon128.png        # Web Store / install dialog icon
└── docs/
    ├── screenshot-import-tab.png
    └── screenshot-bulk-edit-tab.png
```

## Technical Notes

- Uses **Manifest V3** (modern Chrome extension format)
- Injects scripts into the page context (`world: 'MAIN'`) to access the Cadmus React/Apollo internals
- Communicates with the Cadmus GraphQL API at `https://api.cadmus.io/cadmus/api/graphql`
- Extracts TanStack table state via React Fiber traversal for selected-row detection
- Excel parsing via [SheetJS](https://sheetjs.com/) (bundled, no CDN dependency)

## Author

**Lorenzo Vigentini** — [lorenzo@cogentixai.com](mailto:lorenzo@cogentixai.com)

## License

MIT
