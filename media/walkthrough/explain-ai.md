# Explain code and use AI (optional)

AI runs through the **Claude Code CLI** with **your own** Claude login. The extension never sees Claude credentials.

**Setup, once:** install Claude Code and run `claude` in a terminal, then `/login`.

- **`Alt+E`**: explain the selection (or the function at the cursor) **against this MR**: what changed in it, what changed that it depends on, and what to check. It works even on files the MR didn't touch.
- **✨ AI review**: a summary, review units in reading order, and risk hotspots. Choose model, depth and token budget first.
- **Suggest review comments** for a file: accept each as a draft, or discard it. Nothing is posted automatically.

Each result is generated once per MR version and options; clicking again reuses it.
