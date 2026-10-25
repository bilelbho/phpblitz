# Your code and privacy

- **Opening a project never runs it.** PHPBlitz reads and parses its files. Your code runs only when
  you start it: tests, the debugger, the terminal, Composer.
- **Restricted Mode for projects you haven't trusted.** A project can set up Git, PHP, Composer or
  its tests to run commands of its own, so PHPBlitz asks before trusting one. In Restricted Mode
  it reads, searches and analyzes the code, but starts no Git, PHP, Composer, test run or language
  server in it; the terminal still works, since it runs only what you type. Trust it later from
  *Restricted Mode* in the status bar. *Settings ▸ Appearance & Behavior ▸ Trusted Projects* lists
  the trusted folders (each with every project inside it) and can turn the question off.
- **No telemetry and no account.** The only thing PHPBlitz fetches on its own is the update check
  (`latest.json` from the GitHub Releases), which you can turn off in *Settings ▸ Appearance &
  Behavior ▸ Appearance*. Otherwise the network is used only for what you start, like Git push and
  pull, a database connection or an AI request.
- **Passwords and keys** (databases, AI providers) are kept in your system's credential store, not
  in files.

## AI

AI is off until you set up a provider: your own Anthropic, OpenAI or Gemini API key, or Ollama,
whose models run on your computer and send nothing out. Code goes to a provider only when you use a
feature:

| Feature | Sends |
| --- | --- |
| Chat, Edit with AI | The open file, the selection, and outlines of the classes it uses |
| Commit message | The diff of the changes to commit |
| Ghost text (off by default) | The code around the caret |

AI agents you start run under your own account. The MCP server for them is off until you turn it
on, only accepts connections from this computer with its token, and only reads.

More in [SECURITY.md](https://github.com/bilelbho/phpblitz/blob/main/SECURITY.md), including how to
report a vulnerability privately.
