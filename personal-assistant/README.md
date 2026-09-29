# Personal Assistant

A personal assistant that runs quietly on your Mac and connects your to-do list, your email and your texts to your iCloud Calendar.

| You do this | The assistant does this |
|---|---|
| Add a to-do in **Apple Reminders** (iPhone, Mac, Siri, anywhere) with a date or time | Puts it on a **To-Do** calendar in iCloud right away. Completing or deleting the reminder removes it. Dragging the event to a new time on your calendar moves the reminder too. |
| Get an email or text like "Your appointment is Thursday at 3" or "Can you grab Emma at 5?" | A few times a day, Claude reads what's new and puts **suggestions** in a Reminders list called **Assistant Inbox**. You get an iMessage saying how many are waiting. |
| Check off a suggestion in Assistant Inbox (you can edit the title or time first) | Appointments go onto your calendar. Tasks go into your normal to-do list, and onto the calendar if they have a date. |
| Delete a suggestion | It's dismissed and won't be suggested again. |

You keep writing in one place, Reminders, and your calendar stays up to date. Nothing from email or texts reaches your calendar unless you approve it.

---

## One-time setup (about 15 minutes)

### 1. On your iPhone: make sure your texts reach your Mac
- **Settings → [your name] → iCloud → Show All → Messages in iCloud** → on.
- **Settings → Apps → Messages → Text Message Forwarding** → turn on your Mac, so green-bubble SMS texts reach it as well.
- **Settings → [your name] → iCloud → Reminders and Calendars** → on.

### 2. On your Mac: check that the same things are on
- **Messages → Settings → iMessage → Enable Messages in iCloud.**
- **System Settings → [your name] → iCloud**: Calendars and Reminders are on.

### 3. Get two passwords ready
1. **An iCloud app-specific password** (lets the assistant read your mail without your real Apple ID password):
   go to [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security → App-Specific Passwords → +** and name it "Personal Assistant".
2. **An Anthropic API key** (lets Claude read your messages): sign in at [console.anthropic.com](https://console.anthropic.com), add a payment method, then go to **API Keys → Create Key**.

Both are stored in your Mac's **Keychain**, never in a plain file.

### 4. Install
Open **Terminal** on your Mac and run:

```bash
git clone -b claude/personal-assistant https://github.com/45jf5v5jvp-prog/Trading-bot.git
cd Trading-bot/personal-assistant
./install.sh
```

(If it says Python 3.11+ is needed, install [Homebrew](https://brew.sh), run `brew install python@3.12`, then run `./install.sh` again.)

The installer walks you through setup. It asks for your iCloud email, the two passwords, and the phone number where you want the "you have suggestions" iMessages. When macOS asks whether it may access Calendars and Reminders, click **Allow**.

### 5. Allow it to read your texts
macOS protects your messages, so this step has to be done by hand:

1. **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, press **⌘ Cmd + Shift + G**, paste the Python path that setup printed (`assistant doctor` shows it again), and click **Open**.
3. Make sure the switch next to it is on. Add **Terminal** the same way.

Then run `assistant doctor`. Every line should say **allowed / yes / ✓**.

The first few times the background job runs, macOS may ask again whether "python" may use Calendars, Reminders or Messages. Click **Allow** each time.

---

## Everyday use

You don't need to do anything special. Keep using Reminders, and check the **Assistant Inbox** list when you get the iMessage.

Handy Terminal commands:

| Command | What it does |
|---|---|
| `assistant status` | List suggestions waiting for you |
| `assistant scan` | Check email and texts right now instead of waiting |
| `assistant sync` | Sync Reminders ↔ calendar right now |
| `assistant doctor` | Check permissions and show the latest log |
| `assistant setup` | Change passwords or answers from setup |
| `assistant uninstall` | Stop the background job |

**Seeing a to-do twice on your iPhone calendar?** Newer iOS versions can show scheduled reminders in the Calendar app on their own. Pick one: turn that off in the iPhone Calendar app (**Calendars → uncheck "Scheduled Reminders"**), or keep it and set `sync_to_calendar = false` in the settings below.

**Timing:** to-dos and approvals sync **every 5 minutes**. Email and texts are checked at **8am, 11am, 2pm, 5pm and 8pm** by default. If your Mac was asleep, it catches up when it wakes. Your Mac needs to be on and logged in. Sleeping with the lid closed pauses it.

## Settings

All settings are in `~/.personal-assistant/config.toml`, a plain text file you can open in TextEdit. Some useful ones:

- `scan_times`: when to check email and texts.
- `undated = "today"`: also show to-dos **without** a date as all-day items on today's calendar. The default `"skip"` keeps undated to-dos off the calendar so 30–40 items don't clutter it.
- `lists = ["Work", "Home"]`: only mirror these Reminders lists (empty means all of them).
- `todo_calendar`: name of the iCloud calendar your to-dos appear on (default **To-Do**, which you can color or hide in the Calendar app).
- `events_calendar`: where approved appointments go (empty means your default calendar).
- `ignore_senders`: email addresses or phone numbers to never read.
- `model`: the Claude model used. `claude-opus-5-5` is the most accurate. `claude-sonnet-5-5` costs about half as much.

## Privacy

- Everything runs on **your Mac**. Your to-do list and calendar never leave Apple's servers except to sync as they already do.
- New emails and texts are sent to Anthropic's API so Claude can read them. Automated texts from short codes (bank alerts, verification codes) are skipped. Add anyone else you want skipped to `ignore_senders`.
- The assistant only **reads** mail (it doesn't even mark messages as read) and only **reads** texts. It never sends email and never texts anyone except the one digest iMessage to you.
- Emails and texts can't make it do anything. Claude only proposes items, and nothing reaches your calendar until you check it off.

## Cost

Claude API usage is billed by Anthropic based on how much is read. A typical inbox (20–40 new emails a day plus texts) is roughly **$10–25/month** on `claude-opus-5-5`, or about half that on `claude-sonnet-5-5`. You can set a monthly spending limit in the Anthropic console.

## Troubleshooting

| Problem | Fix |
|---|---|
| `doctor` says Calendars/Reminders **denied** | System Settings → Privacy & Security → Calendars (and Reminders) → switch on Terminal and python. |
| "Can't read Messages" | Redo step 5. After `brew upgrade python` the Python path changes, so add the new one. |
| Email sign-in fails | Make a new app-specific password and run `assistant setup` again. |
| No iMessage digest | Check `imessage_to` in settings. The first time, macOS asks whether python may control Messages; click **OK**. |
| Something looks wrong | `assistant doctor` shows the last log lines. The full log is `~/.personal-assistant/assistant.log`. |

## For developers

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

Layout: `apple.py` (EventKit), `reminders_sync.py` (to-do → calendar mirror), `sources/` (IMAP + Messages `chat.db`), `extract.py` (Claude structured output), `inbox.py` (approval flow), `runner.py` (one pass, scheduling), `cli.py`. Sync and inbox logic run against the `Backend` protocol, so they're tested with an in-memory fake (`tests/fakes.py`).
