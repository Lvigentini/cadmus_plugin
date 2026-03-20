# Cadmus Question Library Tools

A Chrome extension that enhances the [Cadmus](https://cadmus.io) question library interface with streamlined bulk import from Excel and QTI XML, flexible column mapping, automatic tagging (topic, Bloom level, difficulty, filename), and batch editing of points, shuffle, and similarity settings across selected questions.

## Screenshots

| Import Tab | Column Mapping |
|:---:|:---:|
| ![Import tab — empty state](docs/screenshot-import-tab.png) | ![Column mapping with tag checkboxes](docs/screenshot-column-mapping.png) |

| Bulk Edit Tab | Delete Tab |
|:---:|:---:|
| ![Bulk Edit tab with MCQ options](docs/screenshot-bulk-edit-tab.png) | ![Delete tab with warning](docs/screenshot-delete-tab.png) |

## Features

### Import Questions
- **Fill-in-Blank, MCQ, Matching, Short Answer** — all four question types supported
- **From Excel (.xlsx)** — Reads the standard question bank format; mixed types detected automatically
- **From QTI XML (.xml)** — Reads Blackboard QTI 1.2 XML exports
- **Column Mapping UI** — After loading an Excel file, a mapping panel lets you verify or reassign how spreadsheet columns map to question fields (row number, type, question text, answers, explanation, Bloom level, difficulty, source)
- **Tag columns** — Check any column in the mapping panel to apply its values as tags on imported questions (e.g. topic, source file, or any custom column)
- **Import All** — One-click button to import every question in the file across all detected types
- **Bloom-level tagging** — Automatically tags each imported question with its Bloom level (e.g. `bloom-remember`, `bloom-apply`)
- **Difficulty tagging** — Tags questions with normalised difficulty (e.g. `difficulty-hard`), stripping decorative characters like `●●●`
- **Filename tagging** — Tags questions with the source filename for traceability
- **FIB auto-blank detection** — Fills in blank markers (`___1___`) automatically when the question text contains them
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
3. Use the tabs to:
   - **Import**: Pick an `.xlsx` or `.xml` file → verify the column mapping → check which columns to use as tags → click **Apply Mapping & Parse** → expand type cards to adjust points/shuffle → click **Import All Questions**
   - **Bulk Edit**: Select questions using the library checkboxes first, then expand a type card, set options, and click **Run**
   - **Delete**: Select questions and click **Delete Selected** (confirmation required)

The log panel at the bottom shows real-time progress for all operations.

## Excel Format

> **Sample file**: [`docs/sample-question-bank.xlsx`](docs/sample-question-bank.xlsx) — 9 questions (2 FIB, 3 MCQ, 2 Matching, 2 Short Answer) with a mix of Bloom levels, difficulties, and topics. Use it to test the import flow or as a template for your own question banks.

The import expects a column layout matching the standard question bank template. Columns can appear in any order — the Column Mapping UI auto-detects headers by name and lets you reassign them if needed.

| Expected Header | Description |
|-----------------|-------------|
| `#` | Row number / question ID |
| `Type` | Question type: MCQ, Fill in the Blank, Matching, Short Answer |
| `Question` | Question text (FIB questions use `___1___`, `___2___` blank markers) |
| `Bloom Level` | Cognitive level — used for auto-tagging (e.g. `bloom-remember`) |
| `Difficulty` | e.g. ● Easy / ●● Medium / ●●● Hard — decorative chars stripped for tagging |
| `Topic` | Topic/tag string — applied as a tag when checked in the mapping panel |
| `Answer / Details` | Answers: semicolon-separated (FIB), newline-separated with `*` or ✓ for correct (MCQ), `→` or `->` paired (Matching) |
| `Explanation` | Feedback shown after answering |
| `source_file` | Source filename — applied as a tag when checked in the mapping panel |

**Answer formats by type**:
- **Fill-in-Blank**: Semicolons separate accepted answers. For multi-blank questions, the pool is split across blanks using ceiling division (e.g., 6 answers for 2 blanks → 3 per blank).
- **MCQ**: Newline- or semicolon-separated choices (whichever yields more options). Correct answer marked with `*` prefix, ✓/✔ suffix, or falls back to last choice. Leading `A.`/`B.`/`C.` labels are stripped automatically.
- **Matching**: Newline-separated pairs using `→` or `->` as separator (e.g. `Term → Definition`).

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
    ├── sample-question-bank.xlsx
    ├── screenshot-import-tab.png
    ├── screenshot-column-mapping.png
    ├── screenshot-bulk-edit-tab.png
    └── screenshot-delete-tab.png
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
