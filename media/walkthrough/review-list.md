# Review 200 files without losing focus

The **Review** list organises the MR:

- **Progress** at the top, **viewed** checkboxes per file (a new push to a file makes it unviewed again)
- **Trivial files hidden**: lockfiles, renames, whitespace-only, import-only, moved code, big rename refactors
- **Suggested order**: types and DTOs → services → controllers → tests
- **Filter** (e.g. *modified only*, *only unviewed*, *only files I own*) and **Sort**
- **Pipeline** status, **approvals**, and **untested changed lines** (🧪) when your CI produces coverage

Press **`Alt+N`** for the next unviewed file, **`Alt+Shift+N`** to mark the current one viewed and move on.

The right side of every diff is the real file: **CMD+click, find references and peek work** as in your own clone.
